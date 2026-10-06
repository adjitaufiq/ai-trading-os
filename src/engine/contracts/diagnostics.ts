// Shared diagnostic contracts. Leaf module: imports nothing, so journal and autopsy both depend on it without cycles.
export type FailureCategory =
  | "LIQUIDITY_SWEEP"
  | "WRONG_LOCATION"
  | "BIAS_CONFLICT"
  | "VOLATILITY_FAILURE"
  | "TRIGGER_FAILURE"
  | "EXECUTION_FAILURE"
  | "NO_FAILURE"
  /** Loss where no rule matched or evidence was missing. Unknowns are never forced into a category. */
  | "UNCLASSIFIED";
