# AI-Voice-Agent

<h1 align="center">🗣️ Voice AI Assistant (Real-time WebSocket, STT, GPT-4, TTS)</h1>

<p align="center">
  A voice-based AI assistant that listens to your microphone input, transcribes it with <strong>ElevenLabs Speech-to-Text</strong>, processes it via <strong>OpenAI GPT-4</strong>, fetches relevant context using <strong>Supabase with vector search</strong>, and responds back using <strong>ElevenLabs TTS</strong>.
</p>

---

<h2>📦 Environment Variables</h2>

You must create a `.env` file in the project root with the following keys:

```env
OPENAI_API_KEY=your_openai_api_key
ELEVEN_LABS_API_KEY=your_elevenlabs_api_key
ELEVEN_VOICE_ID=your_selected_elevenlabs_voice_id
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your_anon_or_service_key


<h2>⚙️ Installation Guide</h2> 
<h3>Step 1: Install Node.js & npm (Ubuntu)</h3>

```commands
sudo apt update
sudo apt install nodejs npm
node -v    # Should print version
npm -v     # Should print version

<h3>Step 2: Clone the Repository</h3>

```commands
git clone https://github.com/your-username/AI-Voice-Agent.git
cd AI-Voice-Agent


<h3>Step 3: Install Dependencies</h3>
```commands
npm install

<h2>🎙️ Run the Project</h2> 
<h3>Step 1: Start the Server</h3>
```commands
node server.js


<p>This will:

Launch a WebSocket server on port 3000

Wait for audio from client

Transcribe audio using ElevenLabs STT

Embed the transcription and fetch relevant context from Supabase (match_documents)

Use GPT-4 to generate an intelligent response

Log the question + answer pair into the Supabase documents table

Convert response text to audio using ElevenLabs TTS

Send all this back to the client</p>

<h3>Step 2: Start the Client</h3>
```commands
node test-client.js


<p>Speak your query into the microphone

Press ENTER to end the recording

You’ll hear an AI-generated response

Press ENTER again to record the next input</p>


🔁 Process Flow (How It Works)
🎧 Client (test-client.js)
Records live audio using ffmpeg in 16-bit mono 16kHz PCM format.

Streams audio to the WebSocket server in real-time.

Waits for the server to respond with a voice reply (MP3) and plays it.

🧠 Server (server.js)
Transcription

Receives the full audio buffer from the client.

Sends it to ElevenLabs STT API.

Receives the transcribed text.

Context Retrieval (RAG with Supabase)

Embeds the transcribed query using OpenAI Embeddings.

Calls the match_documents Supabase RPC to fetch related historical Q&A.

Prepares a context string for GPT-4.

Response Generation (OpenAI GPT-4)

Sends context + user query to OpenAI GPT-4.

Receives a smart, natural language reply.

Memory Logging (Supabase)

Stores the Q&A pair in the documents table.

This improves future context relevance via vector similarity.

Voice Response (ElevenLabs TTS)

Sends the GPT-4 response text to ElevenLabs TTS.

Receives MP3 file.

Sends MP3 back to client.