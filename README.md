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

## Environment variables

- `BOT_TOKEN` (preferred) or `TELEGRAM_BOT_TOKEN`: required for starting the Telegram bot used for deck import and study sessions.
- `SIMILARITY_OK`: value between 0 and 1 (default `0.8`) used to accept close-enough matches as correct answers.
- `SIMILARITY_ALMOST`: value between 0 and 1 (default `0.65`, capped at `SIMILARITY_OK`) used for "almost" matches that still earn partial credit.
- `LEARNING_STEPS_MINUTES`: comma-separated minutes for the spaced-repetition learning steps (default `1,10`; minimum of 1 minute per step).
- `LEARNING_GRADUATE_DAYS`: minimum review interval, in days, after finishing learning steps (default `3`; minimum of 1 day).

## Using the app
- **Host**: open `http://localhost:3000/` (or your custom port) to create quizzes, start rounds, and watch the leaderboard.
- **Players**: share the join code and have students visit `http://localhost:3000/play.html` to enter the game and submit answers in real time.
