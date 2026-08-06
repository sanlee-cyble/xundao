export const VALUE_STATUS = Object.freeze({
  VALUE: "VALUE",
  ZERO: "ZERO",
  NO_SAMPLE: "NO_SAMPLE",
  UNSUPPORTED: "UNSUPPORTED",
  UNRESOLVED: "UNRESOLVED",
  COLLECTION_FAILED: "COLLECTION_FAILED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  MODEL_UNSUPPORTED: "MODEL_UNSUPPORTED",
  MANUAL_REQUIRED: "MANUAL_REQUIRED",
});

export function valueRecord({ value = null, status, source, evidence = [] }) {
  if (!Object.hasOwn(VALUE_STATUS, status)) throw new Error(`未知值状态：${status}`);
  return { value, status, source, evidence };
}
