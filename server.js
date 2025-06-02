// server.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const axios = require("axios");
const FormData = require("form-data");
const OpenAI = require("openai");
const { createClient } = require("@supabase/supabase-js");

// Load environment variables
const {
  OPENAI_API_KEY,
  ELEVEN_LABS_API_KEY,
  ELEVEN_VOICE_ID,
  SUPABASE_URL,
  SUPABASE_KEY,
} = process.env;

// Validate environment variables
if (
  !OPENAI_API_KEY ||
  !ELEVEN_LABS_API_KEY ||
  !ELEVEN_VOICE_ID ||
  !SUPABASE_URL ||
  !SUPABASE_KEY
) {
  console.error("Missing required environment variables.");
  process.exit(1);
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Create output directory if not exist
const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

// Setup WebSocket server on port 3000
const wss = new WebSocket.Server({ port: 3000 }, () => {
  console.log("WebSocket server listening on port 3000");
});

wss.on("connection", (ws) => {
  console.log("Client connected via WebSocket");
  let chunks = [];
  let currentTTSStream = null;
  let interrupted = false;

  ws.on("message", async (data, isBinary) => {
    try {
      // Handle interrupt message
      if (!isBinary && data.toString() === "INTERRUPT") {
        interrupted = true;
        if (currentTTSStream) {
          currentTTSStream.destroy();
          currentTTSStream = null;
          console.log("TTS stream interrupted by client.");
        }
        ws.send(JSON.stringify({ type: "interrupt_ack" }));
        return;
      }

      // Handle audio end
      if (!isBinary && data.toString() === "END") {
        interrupted = false;
        const audioBuffer = Buffer.concat(chunks);
        chunks = [];
        console.log("Received END from client. Processing audio...");

        // Step 1: Transcribe with ElevenLabs STT
        let transcription = "";
        try {
          const sttForm = new FormData();
          sttForm.append("model_id", "scribe_v1");
          sttForm.append("file", audioBuffer, {
            filename: "audio.pcm",
            contentType: "application/octet-stream",
          });
          sttForm.append("file_format", "pcm_s16le_16");
          const sttRes = await axios.post(
            "https://api.elevenlabs.io/v1/speech-to-text",
            sttForm,
            {
              headers: {
                "xi-api-key": ELEVEN_LABS_API_KEY,
                ...sttForm.getHeaders(),
              },
            }
          );
          transcription = sttRes.data.text;
          console.log("Transcription result:", transcription);
          ws.send(JSON.stringify({ type: "transcription", transcription }));
        } catch (err) {
          console.error("Speech-to-text failed:", err.message);
          ws.send(JSON.stringify({ error: "Speech-to-text failed." }));
          return;
        }

        // Step 2: Vector search for context via Supabase
        let contextText = "";
        try {
          const embedRes = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: transcription,
          });
          const embedding = embedRes.data[0].embedding;
          const { data: matches } = await supabase.rpc("match_documents", {
            query_embedding: embedding,
            match_threshold: 0.7,
            match_count: 5,
          });
          if (Array.isArray(matches)) {
            contextText = matches.map((doc) => doc.content).join("\n");
            console.log("Context from vector search:", contextText);
          }
        } catch (err) {
          console.error("Vector search failed:", err.message);
        }

        // Step 3: AI response via OpenAI GPT-4
        let aiResponse = "";
        try {
          const messages = [
            { role: "system", content: `Context:\n${contextText}` },
            { role: "user", content: transcription },
          ];
          const chatRes = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: messages,
          });
          aiResponse = chatRes.choices[0].message.content.trim();
          console.log("AI response:", aiResponse);
          ws.send(
            JSON.stringify({ type: "ai_response", responseText: aiResponse })
          );

          // Log Q&A to Supabase (optional, as before)
          const combinedContent = `Q: ${transcription}\nA: ${aiResponse}`;
          const embedRes2 = await openai.embeddings.create({
            model: "text-embedding-ada-002",
            input: combinedContent,
          });
          const newEmbedding = embedRes2.data[0].embedding;
          await supabase
            .from("documents")
            .insert([{ content: combinedContent, embedding: newEmbedding }]);
          console.log("Logged Q&A to Supabase.");
        } catch (err) {
          console.error("OpenAI GPT-4 request failed:", err.message);
          ws.send(JSON.stringify({ error: "OpenAI GPT-4 request failed." }));
          return;
        }

        // Step 4: Stream TTS audio to client
        try {
          const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;
          const ttsRes = await axios({
            method: "post",
            url: ttsUrl,
            headers: {
              "xi-api-key": ELEVEN_LABS_API_KEY,
              "Content-Type": "application/json",
              Accept: "audio/mpeg",
            },
            data: {
              text: aiResponse,
              model_id: "eleven_multilingual_v2",
              voice_settings: { stability: 0.75, similarity_boost: 0.75 },
            },
            responseType: "stream",
          });

          currentTTSStream = ttsRes.data;
          ws.send(JSON.stringify({ type: "audio_start" }));
          console.log("Streaming TTS audio to client...");

          currentTTSStream.on("data", (chunk) => {
            if (!interrupted) {
              ws.send(chunk, { binary: true });
            }
          });

          currentTTSStream.on("end", () => {
            if (!interrupted) {
              ws.send(JSON.stringify({ type: "audio_end" }));
              console.log("Finished streaming TTS audio.");
            }
            currentTTSStream = null;
          });

          currentTTSStream.on("error", (err) => {
            console.error("TTS streaming error:", err.message);
            ws.send(JSON.stringify({ error: "TTS streaming error." }));
            currentTTSStream = null;
          });
        } catch (err) {
          console.error("Text-to-speech failed:", err.message);
          ws.send(JSON.stringify({ error: "Text-to-speech failed." }));
          return;
        }
      } else if (isBinary) {
        chunks.push(data);
      }
    } catch (err) {
      console.error("Server processing error:", err.message);
      ws.send(JSON.stringify({ error: "Server processing error." }));
    }
  });

  ws.on("close", () => {
    if (currentTTSStream) {
      currentTTSStream.destroy();
      currentTTSStream = null;
    }
    console.log("Client disconnected.");
  });
});