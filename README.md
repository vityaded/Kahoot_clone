# Kahoot-style Classroom Quiz

Interactive quiz web app with typed answers, speed-based scoring, and live leaderboards powered by Express and Socket.IO.

## Prerequisites
- Node.js 18+ and npm

## Setup
Install dependencies:

```bash
npm install
```

## Run locally
Start the development server (defaults to port 3000):

```bash
npm start
```

Customize the port if needed:

```bash
PORT=4000 npm start
```

## Using the app
- **Host**: open `http://localhost:3000/` (or your custom port) to create quizzes, start rounds, and watch the leaderboard.
- **Players**: share the join code and have students visit `http://localhost:3000/play.html` to enter the game and submit answers in real time.

## LLM judge configuration
The server can optionally use an LLM to judge free-text answers. To enable Gemini:

1. Set `GEMINI_API_KEY` for the server process running `server/llmJudge.js` (hosting config, `.env`, or process manager). When both Gemini and OpenAI keys are present, Gemini is tried first.
2. (Optional) Set `GEMINI_MODEL` to override the default (`gemma-3-27b-it`).
3. Restart the server so `server/llmJudge.js` picks up the environment variables.
4. Enable LLM primary judging (set `LLM_PRIMARY_ENABLED=true`), then trigger a submission with debug logs. You should see
   “LLM primary enabled, sending to LLM judge.” logged from `server/evaluation.js`.
