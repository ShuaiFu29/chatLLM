import { AgentToolError } from './agent-tool-error';

const ALLOWED_SCHEMA_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'object',
  'null',
]);

const MAX_SCHEMA_DEPTH = 12;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_PATTERN_LENGTH = 200;
// A pattern is matched against model-produced text inside the request path, and
// JavaScript offers no way to interrupt a running regular expression. The static
// screen below is the primary defence; this cap bounds the damage if a hazardous
// shape ever slips past it.
const MAX_PATTERN_INPUT_LENGTH = 4096;
const MAX_COMPILED_PATTERN_CACHE = 256;
const ALLOWED_SCHEMA_KEYWORDS = new Set([
  '$schema',
  'title',
  'description',
  'default',
  'examples',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
]);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

/**
 * True when an unbounded repetition starts at `index`. Only unbounded
 * repetitions (`*`, `+`, `{n,}`) can drive exponential backtracking; a bounded
 * `{n}` or `{n,m}` expands to a fixed size and is treated as ordinary.
 */
const unboundedQuantifierAt = (pattern: string, index: number) => {
  const char = pattern[index];
  if (char === '*' || char === '+') return true;
  if (char === '{') return /^\{\d+,\}/.test(pattern.slice(index));
  return false;
};

/** Scan a group body for the constructs that make repetition ambiguous. */
const hasAmbiguousRepetition = (body: string) => {
  let inCharacterClass = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (inCharacterClass) {
      if (char === ']') inCharacterClass = false;
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
      continue;
    }
    // Alternation inside a repeated group is the classic `(a|a)*` shape. Telling
    // the harmful cases apart from the harmless ones needs full ambiguity
    // analysis, so every alternation in a repeated group is refused.
    if (char === '|') return true;
    if (unboundedQuantifierAt(body, index)) return true;
  }
  return false;
};

/**
 * Reject regular expressions that can backtrack catastrophically before they are
 * ever compiled. Patterns come from whoever authored the tool, run in the server
 * process, and cannot be cancelled once started, so this errs towards refusing
 * legitimate-but-exotic patterns rather than admitting a hangable one.
 */
const assertSafeStringPattern = (raw: unknown, path: string): string => {
  if (typeof raw !== 'string' || !raw) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (raw.length > MAX_PATTERN_LENGTH) {
    throw new Error(`${path} must be at most ${MAX_PATTERN_LENGTH} characters`);
  }

  const groupStack: { bodyStart: number }[] = [];
  let inCharacterClass = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '\\') {
      const next = raw[index + 1];
      if (next === undefined) throw new Error(`${path} ends with a dangling escape`);
      // Backreferences take the language outside the regular class and are a
      // well-known backtracking amplifier.
      if (/[1-9]/.test(next) || next === 'k') {
        throw new Error(`${path} must not use backreferences`);
      }
      index += 1;
      continue;
    }
    if (inCharacterClass) {
      if (char === ']') inCharacterClass = false;
      continue;
    }
    if (char === '[') {
      inCharacterClass = true;
      continue;
    }
    if (char === '(') {
      if (
        raw.startsWith('(?=', index)
        || raw.startsWith('(?!', index)
        || raw.startsWith('(?<=', index)
        || raw.startsWith('(?<!', index)
      ) {
        throw new Error(`${path} must not use lookahead or lookbehind`);
      }
      if (raw.startsWith('(?<', index)) {
        throw new Error(`${path} must not use named capture groups`);
      }
      if (raw.startsWith('(?', index) && !raw.startsWith('(?:', index)) {
        throw new Error(`${path} uses an unsupported group modifier`);
      }
      groupStack.push({ bodyStart: raw.startsWith('(?:', index) ? index + 3 : index + 1 });
      continue;
    }
    if (char === ')') {
      const group = groupStack.pop();
      if (!group) throw new Error(`${path} has unbalanced parentheses`);
      // Only a repeated group can multiply the work of a repetition inside it.
      if (
        unboundedQuantifierAt(raw, index + 1)
        && hasAmbiguousRepetition(raw.slice(group.bodyStart, index))
      ) {
        throw new Error(`${path} nests unbounded quantifiers, which can backtrack catastrophically`);
      }
      continue;
    }
  }
  if (inCharacterClass) throw new Error(`${path} has an unterminated character class`);
  if (groupStack.length > 0) throw new Error(`${path} has unbalanced parentheses`);

  try {
    new RegExp(raw);
  } catch {
    throw new Error(`${path} is not a valid regular expression`);
  }
  return raw;
};

// Patterns are validated once at definition time, so compiling them per request
// is pure overhead. The cache is bounded because the key space is attacker
// influenced: a tool owner can define many distinct schemas.
const compiledPatterns = new Map<string, RegExp>();

const compilePattern = (pattern: string) => {
  const cached = compiledPatterns.get(pattern);
  if (cached) return cached;
  // JSON Schema `pattern` is an unanchored ECMA-262 expression, which is exactly
  // what RegExp#test provides. No flags, so behaviour matches the spec.
  const compiled = new RegExp(pattern);
  if (compiledPatterns.size >= MAX_COMPILED_PATTERN_CACHE) compiledPatterns.clear();
  compiledPatterns.set(pattern, compiled);
  return compiled;
};

const assertPatternMatches = (
  value: string,
  pattern: string,
  path: string,
) => {
  if (value.length > MAX_PATTERN_INPUT_LENGTH) {
    throw new Error(`${path} is too long to be checked against pattern`);
  }
  if (!compilePattern(pattern).test(value)) {
    throw new Error(`${path} does not match pattern`);
  }
};

const typeMatches = (value: unknown, type: unknown): boolean => {
  if (Array.isArray(type)) return type.some((candidate) => typeMatches(value, candidate));
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isRecord(value);
  if (type === 'null') return value === null;
  return true;
};

const readTypes = (value: unknown, path: string) => {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  if (values.some((candidate) => typeof candidate !== 'string' || !ALLOWED_SCHEMA_TYPES.has(candidate))) {
    throw new Error(`${path}.type contains an unsupported JSON Schema type`);
  }
  if (new Set(values).size !== values.length) {
    throw new Error(`${path}.type contains duplicate values`);
  }
  return values as string[];
};

const assertNonNegativeInteger = (value: unknown, path: string) => {
  if (value !== undefined && (!Number.isInteger(value) || Number(value) < 0)) {
    throw new Error(`${path} must be a non-negative integer`);
  }
};

const assertFiniteNumber = (value: unknown, path: string) => {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error(`${path} must be a finite number`);
  }
};

export interface AgentSchemaDefinitionOptions {
  /**
   * Accept `pattern` on string subschemas. Off by default because it is only
   * sound for tool *input* schemas: an Agent output schema must stay
   * synthesizable, and buildAgentJsonInsufficientEvidenceOutput cannot invent a
   * refusal placeholder that is guaranteed to satisfy an arbitrary regex.
   */
  allowPattern?: boolean;
}

const validateSchemaNode = (
  rawSchema: unknown,
  path: string,
  depth: number,
  options: AgentSchemaDefinitionOptions = {},
) => {
  if (!isRecord(rawSchema)) throw new Error(`${path} must be an object`);
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`JSON Schema exceeds the maximum depth of ${MAX_SCHEMA_DEPTH}`);
  const allowedKeywords = options.allowPattern
    ? new Set([...ALLOWED_SCHEMA_KEYWORDS, 'pattern'])
    : ALLOWED_SCHEMA_KEYWORDS;
  const unsupportedKeyword = Object.keys(rawSchema).find((key) => !allowedKeywords.has(key));
  if (unsupportedKeyword) throw new Error(`${path} uses unsupported keyword: ${unsupportedKeyword}`);
  if (rawSchema.pattern !== undefined) assertSafeStringPattern(rawSchema.pattern, `${path}.pattern`);
  if (rawSchema.$schema !== undefined && typeof rawSchema.$schema !== 'string') {
    throw new Error(`${path}.$schema must be a string`);
  }
  if (rawSchema.title !== undefined && typeof rawSchema.title !== 'string') {
    throw new Error(`${path}.title must be a string`);
  }
  if (rawSchema.description !== undefined && typeof rawSchema.description !== 'string') {
    throw new Error(`${path}.description must be a string`);
  }
  if (rawSchema.examples !== undefined && !Array.isArray(rawSchema.examples)) {
    throw new Error(`${path}.examples must be an array`);
  }

  const types = readTypes(rawSchema.type, path);
  if (rawSchema.enum !== undefined) {
    if (!Array.isArray(rawSchema.enum) || rawSchema.enum.length === 0) {
      throw new Error(`${path}.enum must be a non-empty array`);
    }
    if (rawSchema.enum.some((candidate) => (
      candidate !== null
      && typeof candidate === 'object'
    ))) {
      throw new Error(`${path}.enum only supports primitive JSON values`);
    }
  }

  assertNonNegativeInteger(rawSchema.minLength, `${path}.minLength`);
  assertNonNegativeInteger(rawSchema.maxLength, `${path}.maxLength`);
  assertNonNegativeInteger(rawSchema.minItems, `${path}.minItems`);
  assertNonNegativeInteger(rawSchema.maxItems, `${path}.maxItems`);
  assertFiniteNumber(rawSchema.minimum, `${path}.minimum`);
  assertFiniteNumber(rawSchema.maximum, `${path}.maximum`);
  if (
    typeof rawSchema.minLength === 'number'
    && typeof rawSchema.maxLength === 'number'
    && rawSchema.minLength > rawSchema.maxLength
  ) {
    throw new Error(`${path}.minLength cannot exceed maxLength`);
  }
  if (
    typeof rawSchema.minItems === 'number'
    && typeof rawSchema.maxItems === 'number'
    && rawSchema.minItems > rawSchema.maxItems
  ) {
    throw new Error(`${path}.minItems cannot exceed maxItems`);
  }
  if (
    typeof rawSchema.minimum === 'number'
    && typeof rawSchema.maximum === 'number'
    && rawSchema.minimum > rawSchema.maximum
  ) {
    throw new Error(`${path}.minimum cannot exceed maximum`);
  }

  if (rawSchema.required !== undefined) {
    if (
      !Array.isArray(rawSchema.required)
      || rawSchema.required.some((candidate) => typeof candidate !== 'string' || !candidate)
      || new Set(rawSchema.required).size !== rawSchema.required.length
    ) {
      throw new Error(`${path}.required must contain unique non-empty property names`);
    }
  }
  if (
    rawSchema.additionalProperties !== undefined
    && typeof rawSchema.additionalProperties !== 'boolean'
    && !isRecord(rawSchema.additionalProperties)
  ) {
    throw new Error(`${path}.additionalProperties must be a boolean or schema object`);
  }

  const properties = rawSchema.properties;
  if (properties !== undefined && !isRecord(properties)) {
    throw new Error(`${path}.properties must be an object`);
  }
  if (isRecord(properties)) {
    for (const [key, propertySchema] of Object.entries(properties)) {
      validateSchemaNode(propertySchema, `${path}.properties.${key}`, depth + 1, options);
    }
    const required = Array.isArray(rawSchema.required) ? rawSchema.required : [];
    const unknownRequired = required.find((key) => !Object.hasOwn(properties, key));
    if (unknownRequired) throw new Error(`${path}.required references unknown property: ${unknownRequired}`);
  } else if (Array.isArray(rawSchema.required) && rawSchema.required.length > 0) {
    throw new Error(`${path}.required cannot be used without properties`);
  }

  if (isRecord(rawSchema.additionalProperties)) {
    validateSchemaNode(rawSchema.additionalProperties, `${path}.additionalProperties`, depth + 1, options);
  }
  if (rawSchema.items !== undefined) {
    validateSchemaNode(rawSchema.items, `${path}.items`, depth + 1, options);
  }

  const objectKeywords = properties !== undefined || rawSchema.required !== undefined
    || rawSchema.additionalProperties !== undefined;
  if (objectKeywords && types.length > 0 && !types.includes('object')) {
    throw new Error(`${path} uses object keywords without type object`);
  }
  if (rawSchema.items !== undefined && types.length > 0 && !types.includes('array')) {
    throw new Error(`${path} uses items without type array`);
  }
};

export const validateAgentJsonSchemaDefinition = (
  schema: Record<string, unknown>,
  options: AgentSchemaDefinitionOptions = {},
) => {
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    throw new Error('JSON Schema cannot be serialized');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SCHEMA_BYTES) {
    throw new Error(`JSON Schema exceeds the maximum size of ${MAX_SCHEMA_BYTES} bytes`);
  }
  validateSchemaNode(schema, 'schema', 0, options);
  return schema;
};

export const validateAgentJsonObjectSchemaDefinition = (
  schema: Record<string, unknown>,
  options: AgentSchemaDefinitionOptions = {},
) => {
  validateAgentJsonSchemaDefinition(schema, options);
  if (schema.type !== undefined && !typeMatches({}, schema.type)) {
    throw new Error('schema.type must allow an object at the root');
  }
  return schema;
};

const enumContains = (values: unknown[], candidate: unknown) => values.some((value) => (
  Object.is(value, candidate)
));

const validateValue = (
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
) => {
  if (!typeMatches(value, schema.type)) throw new Error(`${path} has an invalid type`);
  if (Array.isArray(schema.enum) && !enumContains(schema.enum, value)) {
    throw new Error(`${path} is not an allowed value`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new Error(`${path} is shorter than minLength`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      throw new Error(`${path} is longer than maxLength`);
    }
    if (typeof schema.pattern === 'string') {
      assertPatternMatches(value, schema.pattern, path);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new Error(`${path} is below minimum`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new Error(`${path} exceeds maximum`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      throw new Error(`${path} contains too few items`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      throw new Error(`${path} contains too many items`);
    }
    if (isRecord(schema.items)) {
      value.forEach((item, index) => validateValue(item, schema.items as Record<string, unknown>, `${path}[${index}]`));
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((candidate): candidate is string => typeof candidate === 'string')
      : [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} is required`);
    }
    for (const [key, childValue] of Object.entries(value)) {
      const propertySchema = properties[key];
      if (isRecord(propertySchema)) {
        validateValue(childValue, propertySchema, `${path}.${key}`);
      } else if (schema.additionalProperties === false) {
        throw new Error(`${path}.${key} is not allowed`);
      } else if (isRecord(schema.additionalProperties)) {
        validateValue(childValue, schema.additionalProperties, `${path}.${key}`);
      }
    }
  }
};

export const validateAgentJsonSchemaValue = (
  value: unknown,
  schema: Record<string, unknown>,
  path = 'value',
  options: AgentSchemaDefinitionOptions = {},
) => {
  // The schema is re-checked here and not just at definition time: a stored
  // schema could have been written by an older, laxer build. The options must be
  // carried through, or a tool input schema that was legally created with a
  // `pattern` would be rejected at execution time instead.
  validateAgentJsonSchemaDefinition(schema, options);
  validateValue(value, schema, path);
  return value;
};

export const validateAgentJsonSchemaInput = (
  input: unknown,
  schema: Record<string, unknown>,
) => {
  // These messages are the only actionable feedback the model gets when its own
  // arguments are wrong, so they are tagged tool_input_invalid rather than folded
  // into the generic execution failure: a schema mismatch is not retryable, and
  // saying so lets the model correct the call instead of hammering the endpoint.
  if (!isRecord(input)) throw new AgentToolError('tool_input_invalid', 'Tool input must be an object');
  try {
    // This entry point is the tool input path by definition, so it accepts the
    // keywords that are sound for tool inputs. Output validation keeps the
    // stricter default.
    validateAgentJsonSchemaValue(input, schema, 'tool input', { allowPattern: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool input is invalid';
    if (/\.([^.]+) is required$/.test(message)) {
      const key = message.match(/\.([^.]+) is required$/)?.[1] || '';
      throw new AgentToolError('tool_input_invalid', `Missing required tool input: ${key}`, { cause: message });
    }
    if (/\.([^.]+) is not allowed$/.test(message)) {
      const key = message.match(/\.([^.]+) is not allowed$/)?.[1] || '';
      throw new AgentToolError('tool_input_invalid', `Unexpected tool input: ${key}`, { cause: message });
    }
    if (/\.([^.]+) has an invalid type$/.test(message)) {
      const key = message.match(/\.([^.]+) has an invalid type$/)?.[1] || '';
      throw new AgentToolError('tool_input_invalid', `Invalid type for tool input: ${key}`, { cause: message });
    }
    throw new AgentToolError('tool_input_invalid', message);
  }
  return input;
};

export const parseAndValidateAgentJsonOutput = (
  content: string,
  schema: Record<string, unknown>,
) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error('Agent final response is not valid JSON', { cause: error });
  }
  if (!isRecord(parsed)) throw new Error('Agent final JSON response must be an object');
  try {
    validateAgentJsonSchemaValue(parsed, schema, 'output');
  } catch (error) {
    throw new Error(
      `Agent final JSON response does not match its schema: ${error instanceof Error ? error.message : 'invalid output'}`,
      { cause: error },
    );
  }
  return parsed;
};

/**
 * Build a deterministic, schema-valid refusal object for JSON Agents.
 *
 * Grounding is a safety boundary: when the retrieved workspace evidence does
 * not support an answer, returning a free-form Markdown string would violate
 * the Agent's JSON contract.  This helper fills the required fields using
 * conservative values and prefers a field named `answer`, `response`,
 * `message`, `reason`, or `explanation` for the human-readable refusal.
 */
export const buildAgentJsonInsufficientEvidenceOutput = (
  schema: Record<string, unknown>,
  refusalMessage: string,
) => {
  const semanticKeys = new Set([
    'answer',
    'response',
    'message',
    'reason',
    'explanation',
    'summary',
    'result',
  ]);

  const isValid = (value: unknown, node: Record<string, unknown>) => {
    try {
      validateAgentJsonSchemaValue(value, node);
      return true;
    } catch {
      return false;
    }
  };

  const valuesForType = (
    node: Record<string, unknown>,
    preferredKey = '',
    isRoot = false,
  ): unknown => {
    if (node.default !== undefined && isValid(node.default, node)) return node.default;
    if (Array.isArray(node.enum) && node.enum.length > 0) {
      const matchingRefusal = node.enum.find((value) => (
        typeof value === 'string' && /insufficient|evidence|资料不足|无法/i.test(value)
      ));
      return matchingRefusal ?? node.enum[0];
    }

    const rawTypes = Array.isArray(node.type)
      ? node.type.filter((value): value is string => typeof value === 'string')
      : typeof node.type === 'string' ? [node.type] : [];
    const types = rawTypes.length > 0
      ? rawTypes
      : node.properties || node.required || node.additionalProperties !== undefined
        ? ['object']
        : isRoot ? ['object'] : ['string'];
    const type = isRoot && types.includes('object')
      ? 'object'
      : types.includes('string')
      ? 'string'
      : types.includes('object')
        ? 'object'
        : types[0];

    if (type === 'object') {
      const result: Record<string, unknown> = {};
      const properties = isRecord(node.properties) ? node.properties : {};
      const required = Array.isArray(node.required)
        ? node.required.filter((key): key is string => typeof key === 'string')
        : [];
      const keysToFill = new Set(required);
      // If the schema explicitly exposes a semantic answer field but does not
      // require it, populate it so a refusal is still visible to the caller.
      for (const key of Object.keys(properties)) {
        if (semanticKeys.has(key.toLowerCase())) keysToFill.add(key);
      }
      for (const key of keysToFill) {
        const childSchema = isRecord(properties[key])
          ? properties[key]
          : isRecord(node.additionalProperties)
            ? node.additionalProperties
            : {};
        result[key] = valuesForType(childSchema, key);
      }
      if (Object.keys(result).length === 0 && node.additionalProperties !== false) {
        result.answer = refusalMessage;
      }
      return result;
    }
    if (type === 'array') {
      const minimum = Number.isInteger(node.minItems) ? Number(node.minItems) : 0;
      if (minimum === 0) return [];
      const itemSchema = isRecord(node.items) ? node.items : {};
      return Array.from({ length: minimum }, () => valuesForType(itemSchema));
    }
    if (type === 'number' || type === 'integer') {
      const minimum = typeof node.minimum === 'number' ? node.minimum : 0;
      return type === 'integer' ? Math.ceil(minimum) : minimum;
    }
    if (type === 'boolean') return false;
    if (type === 'null') return null;
    if (type === 'string') {
      const maxLength = typeof node.maxLength === 'number' ? node.maxLength : undefined;
      const minLength = typeof node.minLength === 'number' ? node.minLength : 0;
      let value = semanticKeys.has(preferredKey.toLowerCase())
        ? refusalMessage
        : 'insufficient_evidence';
      if (maxLength !== undefined) value = value.slice(0, maxLength);
      if (value.length < minLength) value = `${value}${'—'.repeat(minLength - value.length)}`.slice(0, maxLength);
      return value;
    }
    return null;
  };

  const output = valuesForType(schema, 'answer', true);
  if (!isRecord(output)) throw new Error('Agent JSON refusal schema must produce an object');
  validateAgentJsonSchemaValue(output, schema, 'output');
  return output;
};
