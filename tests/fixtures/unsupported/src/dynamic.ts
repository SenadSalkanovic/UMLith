export function executeEval(expression: string): any {
  const evaluated = eval(expression);
  return evaluated;
}

export function makeDynamicMultiplier(multiplier: number): Function {
  const factory = new Function('val', 'return val * ' + multiplier);
  return factory;
}

export function dynamicDispatch(dispatcher: any, method: string, payload: unknown): any {
  const res = dispatcher[method](payload);
  return res;
}

export function evaluateSwitch(code: number): string {
  switch (code) {
    case 1:
      return 'one';
    case 2:
      return 'two';
    default:
      return 'other';
  }
}

export function supportedAdd(a: number, b: number): number {
  return a + b;
}
