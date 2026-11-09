'use strict';
/* Errors the humanize network raises. code is what the orchestrator turns into a run status (needs-sign-in, budget, cancelled) or names
   the failing part (config, input, rewriter, detector); status is the HTTP status the companion answers with. */

class HumanizeError extends Error {
  constructor(message, code = 'failed', status = 400) {
    super(message);
    this.name = 'HumanizeError';
    this.code = code;
    this.status = status;
  }
}

class BudgetError extends HumanizeError {
  constructor(message) {
    super(message, 'budget', 409);
    this.name = 'BudgetError';
  }
}

module.exports = { HumanizeError, BudgetError };
