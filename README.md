 <h1>🗣️ Voice AI Assistant (Real-time WebSocket, STT, GPT-4, TTS)</h1>

  <p >
    A voice-based AI assistant that listens to your microphone input, transcribes it with <strong>ElevenLabs Speech-to-Text</strong>, processes it via <strong>OpenAI GPT-4</strong>, fetches relevant context using <strong>Supabase with vector search</strong>, and responds back using <strong>ElevenLabs TTS</strong>.
  </p>

  <hr />

  <h2>📦 Environment Variables</h2>
  <p>You must create a <code>.env</code> file in the project root with the following keys:</p>
  <pre><code>
OPENAI_API_KEY=your_openai_api_key
ELEVEN_LABS_API_KEY=your_elevenlabs_api_key
ELEVEN_VOICE_ID=your_selected_elevenlabs_voice_id
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_anon_or_service_key
  </code></pre>

  <h2>⚙️ Installation Guide</h2>

  <h3>Step 1: Install Node.js & npm (Ubuntu)</h3>
  <pre><code>
sudo apt update
sudo apt install nodejs npm
node -v    # Should print version
npm -v     # Should print version
  </code></pre>

  <h3>Step 2: Clone the Repository</h3>
  <pre><code>
git clone https://github.com/your-username/AI-Voice-Agent.git
cd AI-Voice-Agent
  </code></pre>

  <h3>Step 3: Install Dependencies</h3>
  <pre><code>
npm install
  </code></pre>

  <h2>🎙️ Run the Project</h2>

  <h3>Step 1: Start the Server</h3>
  <pre><code>
node server.js
  </code></pre>
  <p>This will:</p>
  <ul>
    <li>Launch a WebSocket server on port 3000</li>
    <li>Wait for audio from client</li>
    <li>Transcribe audio using ElevenLabs STT</li>
    <li>Embed the transcription and fetch relevant context from Supabase (<code>match_documents</code>)</li>
    <li>Use GPT-4 to generate an intelligent response</li>
    <li>Log the question + answer pair into the Supabase <code>documents</code> table</li>
    <li>Convert response text to audio using ElevenLabs TTS</li>
    <li>Send the MP3 response back to the client</li>
  </ul>

  <h3>Step 2: Start the Client</h3>
  <pre><code>
node test-client.js
  </code></pre>
  <p>
    Speak your query into the microphone<br />
    Press ENTER to end the recording<br />
    You’ll hear an AI-generated response<br />
    Press ENTER again to record the next input
  </p>

  <h2>🔁 Process Flow (How It Works)</h2>

  <h3>🎧 Client (<code>test-client.js</code>)</h3>
  <ul>
    <li>Records live audio using ffmpeg in 16-bit mono 16kHz PCM format</li>
    <li>Streams audio to the WebSocket server in real-time</li>
    <li>Waits for the server to respond with a voice reply (MP3) and plays it</li>
  </ul>

  <h3>🧠 Server (<code>server.js</code>)</h3>
  <ol>
    <li><strong>Transcription</strong><br />
      Receives the full audio buffer from the client<br />
      Sends it to ElevenLabs STT API<br />
      Receives the transcribed text
    </li>

    ### 🧠 Server (`server.js`)

        1. **Transcription**  
        - Receives the full audio buffer from the client  
        - Sends it to ElevenLabs STT API  
        - Receives the transcribed text  

        2. **Context Retrieval (RAG with Supabase)**  
        - Embeds the transcribed query using OpenAI Embeddings  
        - Calls the `match_documents` Supabase RPC to fetch related historical Q&A  
        - Prepares a context string for GPT-4  

        3. **Response Generation (OpenAI GPT-4)**  
        - Sends context + user query to OpenAI GPT-4  
        - Receives a smart, natural language reply  

        4. **Memory Logging (Supabase)**  
        - Stores the Q&A pair in the `documents` table  
        - This improves future context relevance via vector similarity  

        5. **Voice Response (ElevenLabs TTS)**  
        - Sends the GPT-4 response text to ElevenLabs TTS  
        - Receives an MP3 file  
        - Sends the MP3 back to the client  

  </ol>

  <hr />
  <p>
    🚀 Built with ❤️ using OpenAI, ElevenLabs, Supabase, Node.js, and WebSockets
  </p>