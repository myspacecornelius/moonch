'use strict';
/* The errors the pipeline modules throw to each other.

   DesignError: a design that cannot be used. `message` names no figure, phrase or text of the withheld material (it is shown to the owner and
   kept in the state); `detail`, when there is one, says exactly what is wrong and goes only to the designer's repair turn and its feedback.
   StopSignal: the owner pressed Stop. BudgetStop: the next step does not fit under the total cap (incomplete: true when the step belonged to
   the checks that must finish before a design may count). Failure: a failure whose message is safe to show the owner as it is.
   AttemptRejected: a design that failed a check before any pilot ran; reasons are safe to show, details go to the designer's feedback only. */

class DesignError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail || message;
  }
}

class StopSignal extends Error {}

class BudgetStop extends Error {
  constructor(message, options = {}) {
    super(message);
    this.incomplete = options.incomplete === true;
  }
}

class Failure extends Error {}

class AttemptRejected extends Error {
  constructor(kind, reasons, details) {
    super(reasons[0]);
    this.kind = kind;
    this.reasons = reasons;
    this.details = details || reasons;
  }
}

module.exports = { DesignError, StopSignal, BudgetStop, Failure, AttemptRejected };
