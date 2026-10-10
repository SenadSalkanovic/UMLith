export function dynamicCompute(code: string): unknown {
  // Unsupported dynamic code evaluation
  eval(code);
  return code;
}
