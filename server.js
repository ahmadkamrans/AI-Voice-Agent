    // server.js

    require('dotenv').config();
    const fs = require('fs');
    const path = require('path');
    const WebSocket = require('ws');
    const axios = require('axios');
    const FormData = require('form-data');
    const OpenAI = require('openai');
    const { createClient } = require('@supabase/supabase-js');

    // Load environment variables
    const {
      OPENAI_API_KEY,
      ELEVEN_LABS_API_KEY,
      ELEVEN_VOICE_ID,
      SUPABASE_URL,
      SUPABASE_KEY
    } = process.env;

    // Validate environment variables
    if (!OPENAI_API_KEY || !ELEVEN_LABS_API_KEY || !ELEVEN_VOICE_ID || !SUPABASE_URL || !SUPABASE_KEY) {
      console.error('Missing required environment variables.');
      process.exit(1);
    }

    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: OPENAI_API_KEY
    });

    // Initialize Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Create output directory if not exist
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir);
    }

    // Setup WebSocket server on port 3000
    const wss = new WebSocket.Server({ port: 3000 }, () => {
      console.log('WebSocket server listening on port 3000');
    });

    wss.on('connection', (ws) => {
      console.log('Client connected via WebSocket');
      let chunks = [];

      ws.on('message', async (data, isBinary) => {
        try {
          if (!isBinary && data.toString() === 'END') {
            console.log('Received END, processing audio');
            const audioBuffer = Buffer.concat(chunks);
            chunks = [];

            // Step 1: Transcribe with ElevenLabs STT
            let transcription = '';
            try {
              const sttForm = new FormData();
              sttForm.append('model_id', 'scribe_v1');
              sttForm.append('file', audioBuffer, {
                filename: 'audio.pcm',
                contentType: 'application/octet-stream'
              });
              sttForm.append('file_format', 'pcm_s16le_16');
              const sttRes = await axios.post(
                'https://api.elevenlabs.io/v1/speech-to-text',
                sttForm,
                {
                  headers: {
                    'xi-api-key': ELEVEN_LABS_API_KEY,
                    ...sttForm.getHeaders()
                  }
                }
              );
              transcription = sttRes.data.text;
              console.log('Transcription:', transcription);
            } catch (err) {
              console.error('STT error:', err.response?.data || err.message);
              ws.send(JSON.stringify({ error: 'Speech-to-text failed.' }));
              return;
            }

            // Step 2: Vector search for context via Supabase
            let contextText = '';
            try {
              const embedRes = await openai.embeddings.create({
                model: 'text-embedding-ada-002',
                input: transcription
              });
              const embedding = embedRes.data[0].embedding;

              const { data: matches, error: rpcError } = await supabase.rpc('match_documents', {
                query_embedding: embedding,
                match_threshold: 0.7,
                match_count: 5
              });
              if (rpcError) throw rpcError;

              if (Array.isArray(matches)) {
                contextText = matches.map(doc => doc.content).join('\n');
              }
              console.log('Context from Supabase:', contextText);
            } catch (err) {
              console.error('Supabase RPC error:', err.message);
            }

            // Step 3: AI response via OpenAI GPT-4
            let aiResponse = '';
            try {
              const messages = [
                { role: 'system', content: `Context:\n${contextText}` },
                { role: 'user', content: transcription }
              ];
              const chatRes = await openai.chat.completions.create({
                model: 'gpt-4',
                messages: messages
              });
              aiResponse = chatRes.choices[0].message.content.trim();
              console.log('AI Response:', aiResponse);

              // Log transcription + AI response to Supabase
              const combinedContent = `Q: ${transcription}\nA: ${aiResponse}`;
              const embedRes2 = await openai.embeddings.create({
                model: 'text-embedding-ada-002',
                input: combinedContent
              });
              const newEmbedding = embedRes2.data[0].embedding;

              const { error: insertError } = await supabase
                .from('documents')
                .insert([{ content: combinedContent, embedding: newEmbedding }]);

              if (insertError) {
                console.error('Error inserting into Supabase documents:', insertError.message);
              } else {
                console.log('Logged Q&A pair into Supabase documents');
              }

            } catch (err) {
              console.error('OpenAI GPT error:', err.response?.data || err.message);
              ws.send(JSON.stringify({ error: 'OpenAI GPT-4 request failed.' }));
              return;
            }

            // Step 4: Text-to-speech with ElevenLabs TTS
            let audioPath = '';
            try {
              const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
              const ttsRes = await axios({
                method: 'post',
                url: ttsUrl,
                headers: {
                  'xi-api-key': ELEVEN_LABS_API_KEY,
                  'Content-Type': 'application/json',
                  'Accept': 'audio/mpeg'
                },
                data: {
                  text: aiResponse,
                  model_id: 'eleven_multilingual_v2',
                  voice_settings: { stability: 0.75, similarity_boost: 0.75 }
                },
                responseType: 'stream'
              });
              const filename = `output_${Date.now()}.mp3`;
              audioPath = path.join(outputDir, filename);
              const writer = fs.createWriteStream(audioPath);
              ttsRes.data.pipe(writer);
              await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
              });
              console.log('Saved TTS audio to', audioPath);
            } catch (err) {
              console.error('TTS error:', err.response?.data || err.message);
              ws.send(JSON.stringify({ error: 'Text-to-speech failed.' }));
              return;
            }

            // Step 5: Send results back to client
            ws.send(JSON.stringify({
              transcription: transcription,
              responseText: aiResponse,
              audioPath: audioPath
            }));

          } else if (isBinary) {
            chunks.push(data);
          } else {
            console.log('Received text message from client:', data.toString());
          }
        } catch (err) {
          console.error('Error processing message:', err);
          ws.send(JSON.stringify({ error: 'Server processing error.' }));
        }
      });

      ws.on('close', () => {
        console.log('Client disconnected');
      });
    });
