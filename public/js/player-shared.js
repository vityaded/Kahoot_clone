(() => {
  function calculateQuestionDuration(prompt = '', baseSeconds = 20) {
    const trimmed = prompt.trim();
    if (!trimmed) return baseSeconds;
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const extraSeconds = Math.floor(wordCount / 2) * 10;
    return baseSeconds + extraSeconds;
  }

  class PlayerView {
    constructor({ onSubmit, onTimeExpired, documentRef = document } = {}) {
      this.doc = documentRef;
      this.onSubmit = onSubmit;
      this.onTimeExpired = onTimeExpired;
      this.timerInterval = null;
      this.baseViewportHeight = window.visualViewport?.height || window.innerHeight;
      this.inputEngaged = false;
      this.lastSubmittedAnswer = '';
      this.playerHasAnswered = false;
      this.lobbyCountdown = null;

      this.el = {
        lobbyStatus: this.doc.getElementById('lobby-status'),
        joinError: this.doc.getElementById('join-error'),
        questionText: this.doc.getElementById('question-text'),
        questionContent: this.doc.querySelector('.question-content'),
        timer: this.doc.getElementById('timer'),
        answerForm: this.doc.getElementById('answer-form'),
        answerInput: this.doc.getElementById('answer-input'),
        submitButton: this.doc.querySelector('#answer-form button'),
        answerFeedback: this.doc.getElementById('answer-feedback'),
        leaderboard: this.doc.getElementById('leaderboard'),
        questionMedia: this.doc.getElementById('question-media'),
        questionProgress: this.doc.getElementById('question-progress'),
        overlay: this.doc.getElementById('leaderboard-overlay'),
        overlayList: this.doc.getElementById('overlay-leaderboard'),
        overlayHint: this.doc.getElementById('overlay-hint'),
        leaderboardCard: this.doc.getElementById('leaderboard-card'),
        correctAnswerDisplay: this.doc.getElementById('correct-answer-display'),
        playerAnswerDisplay: this.doc.getElementById('player-answer-display'),
        questionBoard: this.doc.querySelector('.question-board'),
        answerIndicator: this.doc.getElementById('answer-indicator'),
      };

      this.applyAnswerInputSafeguards();
      this.registerInputEvents();
    }

    setStatus(text) {
      if (this.el.lobbyStatus) this.el.lobbyStatus.textContent = text;
    }

    setError(text) {
      if (this.el.joinError) this.el.joinError.textContent = text;
    }

    setQuestionProgress(text) {
      if (this.el.questionProgress) this.el.questionProgress.textContent = text;
    }

    setQuestionText(text) {
      if (this.el.questionText) this.el.questionText.textContent = text;
    }

    setAnswerFeedback(text, className = '') {
      if (!this.el.answerFeedback) return;
      this.el.answerFeedback.textContent = text;
      this.el.answerFeedback.className = className;
    }

    startQuestion({ prompt, index, total, duration, media }) {
      this.setQuestionProgress(`Question ${index} of ${total}`);
      this.setQuestionText(prompt);
      this.setAnswerFeedback('');
      this.showCorrectAnswer('');
      this.showPlayerAnswer('');
      this.setStatus('');
      this.resetInputEngagement();
      this.applyAnswerInputSafeguards();
      this.el.answerForm?.classList.remove('hidden');
      this.setAnswerWaiting(false);
      if (this.el.answerInput) this.el.answerInput.value = '';
      this.lastSubmittedAnswer = '';
      this.playerHasAnswered = false;
      this.renderMedia(media);
      const targetDuration = Number.isFinite(duration)
        ? duration
        : calculateQuestionDuration(prompt);
      this.startTimer(targetDuration);
      this.hideOverlay();
      this.stopLobbyCountdown();
      this.toggleLeaderboard(false);
    }

    endQuestion({ correctAnswer, playerAnswer }) {
      this.stopTimer();
      this.showCorrectAnswer(`Correct answer: ${correctAnswer}`);
      const answerText = this.playerHasAnswered && playerAnswer ? playerAnswer : 'No answer submitted';
      this.showPlayerAnswer(`Your answer: ${answerText}`);
      this.el.answerForm?.classList.add('hidden');
      this.setAnswerWaiting(false);
      this.resetInputEngagement();
      if (this.el.questionMedia) this.el.questionMedia.innerHTML = '';
      if (this.el.timer) this.el.timer.textContent = 'Time!';
      this.toggleLeaderboard(false);
    }

    showAnswerResult({ correct, partial, earned, correctAnswer, playerAnswer }) {
      if (correct) {
        this.setAnswerFeedback(`Correct! +${earned} points`, 'success');
        this.showAnswerIndicator('correct');
      } else if (partial) {
        this.setAnswerFeedback(`Almost! +${earned} points`, 'warning');
        this.showAnswerIndicator('partial');
      } else {
        this.setAnswerFeedback('Incorrect', 'error');
        this.showAnswerIndicator('incorrect');
      }

      this.showCorrectAnswer(`Correct answer: ${correctAnswer}`);
      this.lastSubmittedAnswer = playerAnswer ?? this.lastSubmittedAnswer;
      const answerText = this.lastSubmittedAnswer || 'No answer submitted';
      this.showPlayerAnswer(`Your answer: ${answerText}`);
      this.playerHasAnswered = true;
      this.resetInputEngagement();
      this.el.answerForm?.classList.add('hidden');
      this.setAnswerWaiting(false);
    }

    renderLeaderboard(players) {
      if (!this.el.leaderboard) return;
      this.el.leaderboard.innerHTML = '';
      if (!Array.isArray(players)) return;
      players.forEach((player, index) => {
        const li = this.doc.createElement('li');
        const accuracy = Number.isFinite(player.accuracy) ? player.accuracy : 0;
        li.innerHTML = `<span>${index + 1}. ${player.name}</span><span>${player.score} pts · ${accuracy}% correct</span>`;
        this.el.leaderboard.appendChild(li);
      });
    }

    renderMedia(media) {
      if (!this.el.questionMedia) return;
      this.el.questionMedia.innerHTML = '';
      if (!media) return;
      if (media.type === 'image') {
        this.el.questionMedia.innerHTML = `<img src="${media.src}" alt="Question media" />`;
      } else if (media.type === 'audio') {
        this.el.questionMedia.innerHTML = `<audio controls src="${media.src}"></audio>`;
      } else if (media.type === 'video') {
        this.el.questionMedia.innerHTML = `<video controls src="${media.src}"></video>`;
      }
    }

    showCorrectAnswer(text) {
      if (!this.el.correctAnswerDisplay) return;
      this.el.correctAnswerDisplay.textContent = text;
      this.el.correctAnswerDisplay.classList.toggle('visible', Boolean(text));
    }

    showPlayerAnswer(text) {
      if (!this.el.playerAnswerDisplay) return;
      this.el.playerAnswerDisplay.textContent = text;
      this.el.playerAnswerDisplay.classList.toggle('visible', Boolean(text));
    }

    showAnswerIndicator(status) {
      if (!this.el.answerIndicator) return;
      let label = '✕';
      if (status === 'correct') label = '✓';
      if (status === 'partial') label = 'OK';

      this.el.answerIndicator.textContent = label;
      this.el.answerIndicator.classList.remove('hidden', 'correct', 'incorrect', 'partial');
      const className = status === 'correct' ? 'correct' : status === 'partial' ? 'partial' : 'incorrect';
      this.el.answerIndicator.classList.add(className);
      this.el.answerIndicator.classList.add('visible');
      setTimeout(() => {
        this.el.answerIndicator?.classList.remove('visible');
        this.el.answerIndicator?.classList.add('hidden');
      }, 1400);
    }

    setAnswerWaiting(isWaiting) {
      if (this.el.answerInput) this.el.answerInput.disabled = isWaiting;
      if (this.el.submitButton) this.el.submitButton.disabled = isWaiting;
    }

    setSubmitHandler(handler) {
      this.onSubmit = handler;
    }

    registerInputEvents() {
      if (this.el.answerForm && this.el.answerInput && this.el.submitButton) {
        this.el.answerForm.addEventListener('submit', (event) => {
          event.preventDefault();
          const trimmedAnswer = this.el.answerInput.value.trim();
          if (!trimmedAnswer) return;
          this.setAnswerWaiting(true);
          if (typeof this.onSubmit === 'function') {
            this.onSubmit(trimmedAnswer);
          }
          this.lastSubmittedAnswer = trimmedAnswer;
          this.playerHasAnswered = true;
          this.setAnswerFeedback('');
        });

        const handleImmediateSubmit = (event) => {
          if (!this.el.answerForm.requestSubmit || this.el.submitButton.disabled) return;
          const trimmedAnswer = this.el.answerInput.value.trim();
          if (!trimmedAnswer) return;
          event.preventDefault();
          this.el.answerForm.requestSubmit();
        };

        this.el.submitButton.addEventListener('pointerdown', handleImmediateSubmit);
        this.el.submitButton.addEventListener('touchstart', handleImmediateSubmit);

        this.el.answerInput.addEventListener('focus', () => this.handleInputFocus());
        this.el.answerInput.addEventListener('blur', () => this.handleInputBlur());
      }

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
          if (!this.inputEngaged) {
            this.baseViewportHeight = Math.max(this.baseViewportHeight, window.visualViewport.height);
            return;
          }

          const heightLoss = this.baseViewportHeight - window.visualViewport.height;
          if (heightLoss > 120) {
            window.requestAnimationFrame(() => this.adjustQuestionPosition());
          }
        });
      }

      window.addEventListener('resize', () => {
        if (!this.inputEngaged) {
          this.baseViewportHeight = Math.max(this.baseViewportHeight, window.innerHeight);
          return;
        }

        window.requestAnimationFrame(() => this.adjustQuestionPosition());
      });
    }

    applyAnswerInputSafeguards() {
      if (!this.el.answerForm || !this.el.answerInput) return;
      this.el.answerForm.setAttribute('autocomplete', 'off');
      this.el.answerInput.setAttribute('name', 'response-field');
      this.el.answerInput.setAttribute('autocomplete', 'new-password');
      this.el.answerInput.setAttribute('autocapitalize', 'off');
      this.el.answerInput.setAttribute('autocorrect', 'off');
      this.el.answerInput.setAttribute('spellcheck', 'false');
    }

    handleInputFocus() {
      this.inputEngaged = true;
      document.body.classList.add('input-engaged');
      this.waitForKeyboardAndAdjust();
    }

    handleInputBlur() {
      this.resetInputEngagement();
    }

    resetInputEngagement() {
      this.inputEngaged = false;
      document.body.classList.remove('input-engaged');
      this.resetQuestionShift();
    }

    waitForKeyboardAndAdjust(attempt = 0) {
      if (!this.inputEngaged) return;

      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      const heightLoss = this.baseViewportHeight - viewportHeight;
      const keyboardLikelyOpen = heightLoss > 120;

      if (keyboardLikelyOpen) {
        window.requestAnimationFrame(() => this.adjustQuestionPosition());
        return;
      }

      if (attempt < 6) {
        setTimeout(() => this.waitForKeyboardAndAdjust(attempt + 1), 80);
      } else {
        window.requestAnimationFrame(() => this.adjustQuestionPosition());
      }
    }

    adjustQuestionPosition() {
      if (!this.el.questionBoard || !this.el.questionContent || !this.el.answerInput) return;
      const questionRect = this.el.questionContent.getBoundingClientRect();
      const inputRect = this.el.answerInput.getBoundingClientRect();
      const desiredGap = 12;
      const rawShift = inputRect.top - questionRect.bottom - desiredGap;
      const boardRect = this.el.questionBoard.getBoundingClientRect();
      const maxShift = Math.max(0, boardRect.bottom - questionRect.bottom - 8);
      const safeShift = Math.min(Math.max(rawShift, 0), maxShift);

      if (safeShift > 2) {
        this.el.questionBoard.style.setProperty('--question-shift', `${safeShift}px`);
        this.el.questionBoard.classList.add('question-shifted');
      } else {
        this.resetQuestionShift();
      }
    }

    resetQuestionShift() {
      this.el.questionBoard?.style.removeProperty('--question-shift');
      this.el.questionBoard?.classList.remove('question-shifted');
    }

    startTimer(seconds) {
      this.stopTimer();
      let remaining = Math.round(seconds);
      if (!Number.isFinite(remaining) || remaining <= 0) {
        if (this.el.timer) this.el.timer.textContent = 'Time!';
        if (typeof this.onTimeExpired === 'function') {
          this.onTimeExpired();
        }
        return;
      }
      if (this.el.timer) this.el.timer.textContent = `${remaining}s`;
      this.timerInterval = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          if (this.el.timer) this.el.timer.textContent = 'Time!';
          this.stopTimer();
          if (typeof this.onTimeExpired === 'function') {
            this.onTimeExpired();
          }
          return;
        }
        if (this.el.timer) this.el.timer.textContent = `${remaining}s`;
      }, 1000);
    }

    stopTimer() {
      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
    }

    hideOverlay() {
      this.el.overlay?.classList.add('hidden');
      if (this.el.overlayList) this.el.overlayList.innerHTML = '';
    }

    toggleLeaderboard(show) {
      if (show) {
        this.el.leaderboardCard?.classList.remove('hidden');
        this.el.overlay?.classList.remove('hidden');
      } else {
        this.el.overlay?.classList.add('hidden');
      }
    }

    startLobbyCountdown(seconds) {
      this.stopLobbyCountdown();
      let remaining = seconds;
      this.setStatus(`Game starting in ${remaining}s...`);
      this.lobbyCountdown = setInterval(() => {
        remaining -= 1;
        this.setStatus(`Game starting in ${Math.max(remaining, 0)}s...`);
        if (remaining <= 0) {
          this.stopLobbyCountdown();
        }
      }, 1000);
    }

    stopLobbyCountdown() {
      if (this.lobbyCountdown) {
        clearInterval(this.lobbyCountdown);
        this.lobbyCountdown = null;
      }
    }
  }

  window.PlayerView = PlayerView;
  window.calculateQuestionDuration = calculateQuestionDuration;
})();
