import { validateAgentJsonObjectSchemaDefinition } from './json-schema-input';
import { validateAgentToolSecrets } from '../../../lib/agentToolSecretKeys';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_OPERATIONS = 50;
const MAX_REFERENCE_DEPTH = 12;
const SCHEMA_KEYS = [
  '$schema', 'title', 'description', 'type',
  'properties', 'required', 'additionalProperties', 'items', 'enum',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
  'pattern',
] as const;

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value && typeof value === 'object' && !Array.isArray(value))
);

export class OpenApiToolImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiToolImportError';
  }
}

export interface ImportedOpenApiOperation {
  key: string;
  operation_id: string;
  method: HttpMethod;
  path: string;
  name: string;
  description: string;
  endpoint: string;
  risk_level: 'read' | 'write';
  input_schema: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  suggested_secret_keys: string[];
  warnings: string[];
  configuration: {
    endpoint: string;
    method: HttpMethod;
    idempotency_mode: 'none';
    timeout_ms: number;
    input_schema: Record<string, unknown>;
    static_headers: Record<string, string>;
    response_path: '';
    output_schema?: Record<string, unknown>;
  };
}

export interface OpenApiToolImportResult {
  title: string;
  version: string;
  operations: ImportedOpenApiOperation[];
  warnings: string[];
  truncated: boolean;
}

const decodePointerToken = (value: string) => value.replace(/~1/g, '/').replace(/~0/g, '~');

const resolveLocalReference = (
  document: Record<string, unknown>,
  reference: string,
  depth: number,
): unknown => {
  if (!reference.startsWith('#/')) {
    throw new OpenApiToolImportError('Remote and file OpenAPI references are not supported');
  }
  if (depth > MAX_REFERENCE_DEPTH) {
    throw new OpenApiToolImportError('OpenAPI reference nesting is too deep');
  }
  let current: unknown = document;
  for (const token of reference.slice(2).split('/').map(decodePointerToken)) {
    if (!isRecord(current) || !(token in current)) {
      throw new OpenApiToolImportError(`OpenAPI reference was not found: ${reference}`);
    }
    current = current[token];
  }
  return current;
};

const dereference = (
  document: Record<string, unknown>,
  value: unknown,
  depth: number,
): unknown => {
  if (!isRecord(value) || typeof value.$ref !== 'string') return value;
  return dereference(document, resolveLocalReference(document, value.$ref, depth), depth + 1);
};

const importSchema = (
  document: Record<string, unknown>,
  rawValue: unknown,
  depth = 0,
): Record<string, unknown> => {
  if (depth > MAX_REFERENCE_DEPTH) throw new OpenApiToolImportError('OpenAPI Schema is too deeply nested');
  const resolved = dereference(document, rawValue, depth);
  if (!isRecord(resolved)) throw new OpenApiToolImportError('OpenAPI Schema must be an object');
  if (resolved.oneOf || resolved.anyOf || resolved.allOf || resolved.not) {
    throw new OpenApiToolImportError('Composed OpenAPI schemas are not supported by Agent tools');
  }
  const imported: Record<string, unknown> = {};
  for (const key of SCHEMA_KEYS) {
    const value = resolved[key];
    if (
      value === undefined
      || key === 'properties'
      || key === 'items'
      || key === 'additionalProperties'
    ) continue;
    imported[key] = value;
  }
  if (resolved.nullable === true && typeof imported.type === 'string') {
    imported.type = [imported.type, 'null'];
  }
  if (isRecord(resolved.properties)) {
    imported.properties = Object.fromEntries(Object.entries(resolved.properties).map(
      ([name, schema]) => [name, importSchema(document, schema, depth + 1)],
    ));
  }
  if (resolved.items !== undefined) imported.items = importSchema(document, resolved.items, depth + 1);
  if (typeof resolved.additionalProperties === 'boolean') {
    imported.additionalProperties = resolved.additionalProperties;
  } else if (isRecord(resolved.additionalProperties)) {
    imported.additionalProperties = importSchema(document, resolved.additionalProperties, depth + 1);
  }
  return imported;
};

const readServerUrl = (
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  baseUrl?: string,
) => {
  if (baseUrl) return baseUrl;
  const candidates = [operation.servers, pathItem.servers, document.servers];
  const servers = candidates.find((value) => Array.isArray(value) && value.length > 0) as unknown[] | undefined;
  const first = servers?.[0];
  if (!isRecord(first) || typeof first.url !== 'string') {
    throw new OpenApiToolImportError('OpenAPI operation has no server URL; provide base_url explicitly');
  }
  const variables = isRecord(first.variables) ? first.variables : {};
  return first.url.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const variable = variables[name];
    if (!isRecord(variable) || typeof variable.default !== 'string') {
      throw new OpenApiToolImportError(`OpenAPI server variable has no default: ${name}`);
    }
    return variable.default;
  });
};

const buildEndpoint = (serverUrl: string, operationPath: string) => {
  let base: URL;
  try {
    base = new URL(serverUrl);
  } catch {
    throw new OpenApiToolImportError('OpenAPI server URL must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.hash) {
    throw new OpenApiToolImportError('OpenAPI server URL must be a credential-free HTTP(S) URL');
  }
  const basePath = base.pathname.replace(/\/$/, '');
  base.pathname = `${basePath}/${operationPath.replace(/^\//, '')}`;
  return base.toString();
};

const operationName = (operationId: string, method: string, path: string) => {
  const candidate = operationId || `${method}_${path}`;
  const normalized = candidate
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return normalized || `${method}_operation`;
};

const arrayValues = (value: unknown) => Array.isArray(value) ? value : [];

const securitySuggestions = (
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
) => {
  const components = isRecord(document.components) ? document.components : {};
  const schemes = isRecord(components.securitySchemes) ? components.securitySchemes : {};
  const security = operation.security === undefined ? document.security : operation.security;
  const requirements = arrayValues(security).filter(isRecord);
  const names = new Set<string>(requirements[0] ? Object.keys(requirements[0]) : []);
  const suggestions: string[] = [];
  const warnings: string[] = requirements.length > 1
    ? ['Only the first OpenAPI security alternative was suggested.']
    : [];
  for (const name of names) {
    const scheme = dereference(document, schemes[name], 0);
    if (!isRecord(scheme)) {
      warnings.push(`Security scheme was not found: ${name}`);
      continue;
    }
    if (scheme.type === 'http' && String(scheme.scheme).toLowerCase() === 'bearer') {
      suggestions.push('bearer_token');
    } else if (
      scheme.type === 'apiKey'
      && typeof scheme.name === 'string'
      && (scheme.in === 'header' || scheme.in === 'query')
    ) {
      suggestions.push(`${scheme.in}:${scheme.name}`);
    } else {
      warnings.push(`Security scheme requires manual integration: ${name}`);
    }
  }
  const unique = [...new Set(suggestions)];
  try {
    validateAgentToolSecrets(Object.fromEntries(unique.map((key) => [key, 'placeholder'])));
  } catch (error) {
    throw new OpenApiToolImportError(
      error instanceof Error ? error.message : 'OpenAPI security scheme is not safe to import',
    );
  }
  return { suggestions: unique, warnings };
};

const readParameters = (
  document: Record<string, unknown>,
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  method: HttpMethod,
) => {
  const combined = [...arrayValues(pathItem.parameters), ...arrayValues(operation.parameters)];
  const byIdentity = new Map<string, Record<string, unknown>>();
  for (const raw of combined) {
    const value = dereference(document, raw, 0);
    if (!isRecord(value) || typeof value.name !== 'string' || typeof value.in !== 'string') {
      throw new OpenApiToolImportError('OpenAPI parameter is malformed');
    }
    byIdentity.set(`${value.in}:${value.name}`, value);
  }
  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  const warnings: string[] = [];
  for (const parameter of byIdentity.values()) {
    const name = String(parameter.name);
    const location = String(parameter.in);
    if (location === 'header' || location === 'cookie') {
      if (parameter.required === true) {
        throw new OpenApiToolImportError(`Required ${location} parameter cannot be mapped safely: ${name}`);
      }
      warnings.push(`Optional ${location} parameter was omitted: ${name}`);
      continue;
    }
    if (!['path', 'query'].includes(location)) {
      throw new OpenApiToolImportError(`Unsupported OpenAPI parameter location: ${location}`);
    }
    if (method !== 'GET' && location === 'query') {
      throw new OpenApiToolImportError(`Non-GET query parameter requires manual mapping: ${name}`);
    }
    const expectedStyle = location === 'path' ? 'simple' : 'form';
    if (parameter.style !== undefined && parameter.style !== expectedStyle) {
      throw new OpenApiToolImportError(`Unsupported ${location} parameter style for ${name}`);
    }
    if (parameter.allowReserved === true) {
      throw new OpenApiToolImportError(`allowReserved query parameters require manual mapping: ${name}`);
    }
    if (properties[name] !== undefined) throw new OpenApiToolImportError(`Duplicate parameter name: ${name}`);
    const parameterSchema = importSchema(document, parameter.schema || { type: 'string' });
    const types = Array.isArray(parameterSchema.type)
      ? parameterSchema.type
      : [parameterSchema.type];
    if (
      types.some((type) => type !== undefined && !['string', 'number', 'integer', 'boolean', 'null'].includes(String(type)))
      || types.every((type) => type === undefined)
    ) {
      throw new OpenApiToolImportError(`Only scalar ${location} parameters are supported: ${name}`);
    }
    properties[name] = parameterSchema;
    if (location === 'path' || parameter.required === true) required.add(name);
  }
  return { properties, required, warnings };
};

const readRequestBody = (
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
  method: HttpMethod,
) => {
  if (operation.requestBody === undefined) {
    return { properties: {}, required: new Set<string>(), warnings: [] as string[] };
  }
  if (method === 'GET') {
    return {
      properties: {},
      required: new Set<string>(),
      warnings: ['GET requestBody was omitted.'],
    };
  }
  const body = dereference(document, operation.requestBody, 0);
  if (!isRecord(body) || !isRecord(body.content)) {
    throw new OpenApiToolImportError('OpenAPI requestBody content is malformed');
  }
  const media = body.content['application/json'];
  if (!isRecord(media) || media.schema === undefined) {
    throw new OpenApiToolImportError('Only application/json request bodies are supported');
  }
  const schema = importSchema(document, media.schema);
  if (schema.type !== 'object' && !isRecord(schema.properties)) {
    throw new OpenApiToolImportError('OpenAPI JSON request body must be an object schema');
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(body.required === true && Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : []);
  return {
    properties,
    required,
    warnings: body.required === true
      ? []
      : ['Optional requestBody was flattened with optional properties.'],
  };
};

const readOutputSchema = (
  document: Record<string, unknown>,
  operation: Record<string, unknown>,
) => {
  if (!isRecord(operation.responses)) return undefined;
  const success = Object.entries(operation.responses)
    .filter(([status]) => /^2\d\d$/.test(status))
    .sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
  const response = dereference(document, success, 0);
  if (!isRecord(response) || !isRecord(response.content)) return undefined;
  const media = response.content['application/json'];
  if (!isRecord(media) || media.schema === undefined) return undefined;
  return importSchema(document, media.schema);
};

export const importOpenApiDocument = (input: {
  document: Record<string, unknown>;
  baseUrl?: string;
}): OpenApiToolImportResult => {
  const documentBytes = Buffer.byteLength(JSON.stringify(input.document), 'utf8');
  if (documentBytes > MAX_DOCUMENT_BYTES) {
    throw new OpenApiToolImportError('OpenAPI document exceeds 512 KiB');
  }
  const version = typeof input.document.openapi === 'string' ? input.document.openapi : '';
  if (!/^3\.(?:0|1)\./.test(version)) {
    throw new OpenApiToolImportError('Only OpenAPI 3.0 and 3.1 documents are supported');
  }
  if (!isRecord(input.document.paths)) throw new OpenApiToolImportError('OpenAPI paths must be an object');
  const info = isRecord(input.document.info) ? input.document.info : {};
  const operations: ImportedOpenApiOperation[] = [];
  const warnings: string[] = [];
  let truncated = false;

  for (const [path, rawPathItem] of Object.entries(input.document.paths)) {
    if (!path.startsWith('/') || !isRecord(rawPathItem)) {
      warnings.push(`Malformed OpenAPI path was skipped: ${path}`);
      continue;
    }
    for (const rawMethod of METHODS) {
      const rawOperation = rawPathItem[rawMethod];
      if (!isRecord(rawOperation)) continue;
      if (operations.length >= MAX_OPERATIONS) {
        truncated = true;
        break;
      }
      try {
        const method = rawMethod.toUpperCase() as HttpMethod;
        const parameters = readParameters(input.document, rawPathItem, rawOperation, method);
        const body = readRequestBody(input.document, rawOperation, method);
        const collisions = Object.keys(body.properties).filter((name) => parameters.properties[name]);
        if (collisions.length > 0) {
          throw new OpenApiToolImportError(`Parameter and body property collide: ${collisions[0]}`);
        }
        const inputSchema: Record<string, unknown> = {
          type: 'object',
          properties: { ...parameters.properties, ...body.properties },
          required: [...new Set([...parameters.required, ...body.required])],
          additionalProperties: false,
        };
        if ((inputSchema.required as string[]).length === 0) delete inputSchema.required;
        validateAgentJsonObjectSchemaDefinition(inputSchema, { allowPattern: true });
        const outputSchema = readOutputSchema(input.document, rawOperation);
        if (outputSchema) validateAgentJsonObjectSchemaDefinition(
          outputSchema.type === 'object' || isRecord(outputSchema.properties)
            ? outputSchema
            : { type: 'object', properties: { result: outputSchema }, required: ['result'] },
        );
        const endpoint = buildEndpoint(
          readServerUrl(input.document, rawOperation, rawPathItem, input.baseUrl),
          path,
        );
        const security = securitySuggestions(input.document, rawOperation);
        const operationId = typeof rawOperation.operationId === 'string'
          ? rawOperation.operationId.trim().slice(0, 160)
          : '';
        const name = operationName(operationId, rawMethod, path);
        const operationWarnings = [...parameters.warnings, ...body.warnings, ...security.warnings];
        const configuration = {
          endpoint,
          method,
          idempotency_mode: 'none' as const,
          timeout_ms: 15000,
          input_schema: inputSchema,
          static_headers: {},
          response_path: '' as const,
          ...(outputSchema ? { output_schema: outputSchema } : {}),
        };
        const imported: ImportedOpenApiOperation = {
          key: `${method} ${path}`,
          operation_id: operationId || name,
          method,
          path,
          name,
          description: String(rawOperation.summary || rawOperation.description || '').slice(0, 1000),
          endpoint,
          risk_level: method === 'GET' ? 'read' : 'write',
          input_schema: inputSchema,
          ...(outputSchema ? { output_schema: outputSchema } : {}),
          suggested_secret_keys: security.suggestions,
          warnings: operationWarnings,
          configuration,
        };
        if (Buffer.byteLength(JSON.stringify([...operations, imported]), 'utf8') > MAX_RESULT_BYTES) {
          truncated = true;
          break;
        }
        operations.push(imported);
      } catch (error) {
        warnings.push(`${rawMethod.toUpperCase()} ${path}: ${error instanceof Error ? error.message : 'Import failed'}`);
      }
    }
    if (truncated) break;
  }
  if (truncated) warnings.push('OpenAPI import stopped at the operation or response-size limit.');
  if (operations.length === 0) throw new OpenApiToolImportError(
    warnings[0] || 'OpenAPI document contains no supported operations',
  );
  return {
    title: typeof info.title === 'string' ? info.title.slice(0, 200) : '',
    version,
    operations,
    warnings: [...new Set(warnings)].slice(0, 100),
    truncated,
  };
};
