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

const validateSchemaNode = (
  rawSchema: unknown,
  path: string,
  depth: number,
) => {
  if (!isRecord(rawSchema)) throw new Error(`${path} must be an object`);
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`JSON Schema exceeds the maximum depth of ${MAX_SCHEMA_DEPTH}`);
  const unsupportedKeyword = Object.keys(rawSchema).find((key) => !ALLOWED_SCHEMA_KEYWORDS.has(key));
  if (unsupportedKeyword) throw new Error(`${path} uses unsupported keyword: ${unsupportedKeyword}`);
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
      validateSchemaNode(propertySchema, `${path}.properties.${key}`, depth + 1);
    }
    const required = Array.isArray(rawSchema.required) ? rawSchema.required : [];
    const unknownRequired = required.find((key) => !Object.hasOwn(properties, key));
    if (unknownRequired) throw new Error(`${path}.required references unknown property: ${unknownRequired}`);
  } else if (Array.isArray(rawSchema.required) && rawSchema.required.length > 0) {
    throw new Error(`${path}.required cannot be used without properties`);
  }

  if (isRecord(rawSchema.additionalProperties)) {
    validateSchemaNode(rawSchema.additionalProperties, `${path}.additionalProperties`, depth + 1);
  }
  if (rawSchema.items !== undefined) {
    validateSchemaNode(rawSchema.items, `${path}.items`, depth + 1);
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
  validateSchemaNode(schema, 'schema', 0);
  return schema;
};

export const validateAgentJsonObjectSchemaDefinition = (
  schema: Record<string, unknown>,
) => {
  validateAgentJsonSchemaDefinition(schema);
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
) => {
  validateAgentJsonSchemaDefinition(schema);
  validateValue(value, schema, path);
  return value;
};

export const validateAgentJsonSchemaInput = (
  input: unknown,
  schema: Record<string, unknown>,
) => {
  if (!isRecord(input)) throw new Error('Tool input must be an object');
  try {
    validateAgentJsonSchemaValue(input, schema, 'tool input');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Tool input is invalid';
    if (/\.([^.]+) is required$/.test(message)) {
      const key = message.match(/\.([^.]+) is required$/)?.[1] || '';
      throw new Error(`Missing required tool input: ${key}`, { cause: error });
    }
    if (/\.([^.]+) is not allowed$/.test(message)) {
      const key = message.match(/\.([^.]+) is not allowed$/)?.[1] || '';
      throw new Error(`Unexpected tool input: ${key}`, { cause: error });
    }
    if (/\.([^.]+) has an invalid type$/.test(message)) {
      const key = message.match(/\.([^.]+) has an invalid type$/)?.[1] || '';
      throw new Error(`Invalid type for tool input: ${key}`, { cause: error });
    }
    throw error;
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
