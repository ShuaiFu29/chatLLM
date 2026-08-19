type Token = { type: 'number'; value: number } | { type: 'operator'; value: string };

const tokenize = (expression: string): Token[] => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const character = expression[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' || /[+*/%^()]/.test(character)) {
      tokens.push({ type: 'operator', value: character });
      index += 1;
      continue;
    }
    const match = expression.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?/i);
    if (!match) throw new Error('Expression contains unsupported characters');
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error('Expression contains an invalid number');
    tokens.push({ type: 'number', value });
    index += match[0].length;
  }
  return tokens;
};

export const evaluateAgentExpression = (expression: string) => {
  if (!expression.trim() || expression.length > 500) throw new Error('Expression is empty or too long');
  const tokens = tokenize(expression);
  let position = 0;

  const peek = () => tokens[position];
  const takeOperator = (operator: string) => {
    const token = peek();
    if (token?.type !== 'operator' || token.value !== operator) return false;
    position += 1;
    return true;
  };

  const parsePrimary = (): number => {
    if (takeOperator('(')) {
      const value = parseAdditive();
      if (!takeOperator(')')) throw new Error('Missing closing parenthesis');
      return value;
    }
    const token = tokens[position];
    if (!token || token.type !== 'number') throw new Error('Expected a number');
    position += 1;
    return token.value;
  };

  const parseUnary = (): number => {
    if (takeOperator('+')) return parseUnary();
    if (takeOperator('-')) return -parseUnary();
    return parsePrimary();
  };

  const parsePower = (): number => {
    const left = parseUnary();
    return takeOperator('^') ? left ** parsePower() : left;
  };

  const parseMultiplicative = (): number => {
    let value = parsePower();
    while (true) {
      if (takeOperator('*')) value *= parsePower();
      else if (takeOperator('/')) value /= parsePower();
      else if (takeOperator('%')) value %= parsePower();
      else break;
      if (!Number.isFinite(value)) throw new Error('Calculation is not finite');
    }
    return value;
  };

  const parseAdditive = (): number => {
    let value = parseMultiplicative();
    while (true) {
      if (takeOperator('+')) value += parseMultiplicative();
      else if (takeOperator('-')) value -= parseMultiplicative();
      else break;
      if (!Number.isFinite(value)) throw new Error('Calculation is not finite');
    }
    return value;
  };

  const result = parseAdditive();
  if (position !== tokens.length) throw new Error('Unexpected token in expression');
  if (!Number.isFinite(result)) throw new Error('Calculation is not finite');
  return result;
};
