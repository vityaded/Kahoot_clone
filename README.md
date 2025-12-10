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

## Homework assignments
- Open `http://localhost:3000/assignments.html?quizId=YOURCODE` to create a homework assignment for an existing quiz and review learner submissions.
- Share the generated homework link (it points to `homework.html` with the assignment ID) so participants can complete the quiz asynchronously and receive a score and correctness summary.
