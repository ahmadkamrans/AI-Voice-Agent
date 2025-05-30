
# Voice AI Agent (Node.js)

This is a real-time voice AI agent using:
- **Telnyx** for voice call routing and audio streaming
- **ElevenLabs** for speech-to-text (STT) and text-to-speech (TTS)
- **OpenAI (GPT + RAG)** for conversational intelligence
- **pgvector** for context-aware responses
- **Redis + BullMQ** for scalable concurrent processing

---

## 📦 Project Structure

```
voice_ai_agent/
├── server.js         # Main server: handles voice, AI, audio
├── test-client.js    # Local microphone test client
├── .env.example      # Environment variables template
└── public/           # Stores generated MP3 files
```

---

## 🚀 How It Works (Call Flow)

1. User **calls your Telnyx number**.
2. Telnyx triggers `/webhooks/voice`, and the call is answered.
3. A **real-time audio stream** starts via WebSocket.
4. Audio is sent to **ElevenLabs STT** and transcribed.
5. Transcribed text is passed to **OpenAI GPT**, with **pgvector context retrieval**.
6. AI response is converted to **speech using ElevenLabs TTS**.
7. MP3 is **played back to the caller** via Telnyx's `actions/play`.
8. This loop continues as long as the caller stays connected.

---

## 🧠 AI Logic: LangChain-Style RAG

- Transcription is embedded via `text-embedding-ada-002`.
- pgvector performs similarity search from `documents` table.
- Relevant context is injected into the GPT chat for improved answers.

---

## 📂 Key Files & Functions

### `server.js`

- **`/webhooks/voice`**
  - Accepts Telnyx call and starts audio stream
- **`wss.on('connection')`**
  - Handles WebSocket stream, buffers audio until `__END__` is sent
- **`voiceQueue`**
  - Redis queue using BullMQ to handle each user session independently
- **`transcribeAudio(buffer)`**
  - Sends audio to ElevenLabs STT and returns the transcript
- **`fetchContextFromPgVector(query)`**
  - Gets nearest context from your `documents` table
- **`askOpenAIWithContext(transcript, context)`**
  - Passes user input + context to OpenAI GPT
- **`synthesizeSpeech(text)`**
  - Uses ElevenLabs to turn GPT response into speech (MP3)

### `test-client.js`

- Streams mic audio to WebSocket server
- Sends `__END__` after silence
- Allows testing without phone call

---

## ⚙️ Environment Setup

Copy `.env.example` to `.env` and fill in:
```
OPENAI_API_KEY=
ELEVENLABS_API_KEY=
TELNYX_API_KEY=
DATABASE_URL=
BASE_URL=http://localhost:3000
BASE_WS_URL=ws://localhost:3000
REDIS_URL=redis://localhost:6379
```

---

## 🧪 Run the App

1. Start Redis and PostgreSQL
2. Start the voice server:
```bash
node server.js
```

3. Run test client:
```bash
node test-client.js
```

---

## 🔁 Real-Time Conversation

Each turn:
- Audio → Transcription → Context + GPT → Speech → Telnyx Playback

You can keep talking and getting replies — it’s a natural loop.

---

## 🐳 Docker (Optional)

Coming soon: Dockerfile + Compose for Redis, Node, Postgres.

---

## 📞 Scaling

- Horizontally scale using PM2 or Docker swarm
- BullMQ + Redis ensure workers can process 1000+ concurrent calls

---

## 📄 License

MIT
