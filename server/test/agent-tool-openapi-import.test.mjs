import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const { importOpenApiDocument } = require(path.join(
  serverRoot, 'dist', 'modules', 'agents', 'runtime', 'openapi-tool-import.js',
));

test('OpenAPI import maps a secured GET path/query operation without fetching the document', () => {
  const result = importOpenApiDocument({
    document: {
      openapi: '3.1.0',
      info: { title: 'Weather API', version: '1.0.0' },
      servers: [{
        url: 'https://{region}.example.com/v1',
        variables: { region: { default: 'api' } },
      }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer' },
        },
        schemas: {
          Weather: {
            type: 'object',
            properties: { temperature: { type: 'number' } },
            required: ['temperature'],
          },
        },
      },
      paths: {
        '/weather/{city}': {
          get: {
            operationId: 'getWeather',
            summary: 'Read current weather',
            parameters: [
              { name: 'city', in: 'path', required: true, schema: { type: 'string' } },
              {
                name: 'units',
                in: 'query',
                schema: { type: 'string', enum: ['c', 'f'], default: 'must-not-copy' },
              },
            ],
            responses: {
              200: {
                content: {
                  'application/json': { schema: { $ref: '#/components/schemas/Weather' } },
                },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(result.title, 'Weather API');
  assert.equal(result.operations.length, 1);
  const operation = result.operations[0];
  assert.equal(operation.key, 'GET /weather/{city}');
  assert.equal(operation.endpoint, 'https://api.example.com/v1/weather/%7Bcity%7D');
  assert.equal(operation.risk_level, 'read');
  assert.deepEqual(operation.input_schema.required, ['city']);
  assert.deepEqual(Object.keys(operation.input_schema.properties), ['city', 'units']);
  assert.equal(operation.input_schema.properties.units.default, undefined);
  assert.deepEqual(operation.suggested_secret_keys, ['bearer_token']);
  assert.equal(operation.output_schema.properties.temperature.type, 'number');
  assert.equal(operation.configuration.output_schema.properties.temperature.type, 'number');
});

test('OpenAPI import merges an object JSON body and suggests safe apiKey destinations', () => {
  const result = importOpenApiDocument({
    baseUrl: 'https://override.example.com/api',
    document: {
      openapi: '3.0.3',
      info: { title: 'Tickets', version: '2' },
      servers: [{ url: 'https://ignored.example.com' }],
      components: {
        securitySchemes: {
          key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
        },
      },
      paths: {
        '/tickets/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          patch: {
            security: [{ key: [] }],
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { status: { type: 'string', nullable: true } },
                    required: ['status'],
                  },
                },
              },
            },
            responses: { 204: { description: 'updated' } },
          },
        },
      },
    },
  });
  const operation = result.operations[0];
  assert.equal(operation.method, 'PATCH');
  assert.equal(operation.endpoint, 'https://override.example.com/api/tickets/%7Bid%7D');
  assert.equal(operation.risk_level, 'write');
  assert.deepEqual(operation.input_schema.required, ['id', 'status']);
  assert.deepEqual(operation.input_schema.properties.status.type, ['string', 'null']);
  assert.deepEqual(operation.suggested_secret_keys, ['header:X-Api-Key']);
});

test('OpenAPI import rejects unsafe authentication and unsupported operation mappings', () => {
  assert.throws(() => importOpenApiDocument({
    document: { swagger: '2.0', paths: {} },
  }), /Only OpenAPI 3.0 and 3.1/);

  assert.throws(() => importOpenApiDocument({
    document: {
      openapi: '3.1.0',
      info: { title: 'Unsafe', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      components: {
        securitySchemes: {
          host: { type: 'apiKey', in: 'header', name: 'Host' },
        },
      },
      security: [{ host: [] }],
      paths: { '/items': { get: { responses: { 200: { description: 'ok' } } } } },
    },
  }), /cannot be stored/);

  assert.throws(() => importOpenApiDocument({
    document: {
      openapi: '3.1.0',
      info: { title: 'Manual mapping', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/items': {
          post: {
            parameters: [{ name: 'tenant', in: 'query', schema: { type: 'string' } }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    },
  }), /Non-GET query parameter requires manual mapping/);

  assert.throws(() => importOpenApiDocument({
    document: {
      openapi: '3.1.0',
      info: { title: 'Array query', version: '1' },
      servers: [{ url: 'https://api.example.com' }],
      paths: {
        '/items': {
          get: {
            parameters: [{ name: 'tags', in: 'query', schema: { type: 'array', items: { type: 'string' } } }],
            responses: { 200: { description: 'ok' } },
          },
        },
      },
    },
  }), /Only scalar query parameters are supported/);
});
