/**
 * The tool-definition boundary, owned by this plugin.
 *
 * Why this file exists
 * --------------------
 * The host exposes `defineTool` from `@deepseek-ai/dsh-tools`. That package is
 * packaged inside the DSH application bundle (`E:\DSH\resources\app.asar`), and
 * it is **not resolvable from an external plugin at run time**: neither
 * `~/.dsh/profiles/desktop/node_modules` nor any directory above the plugin
 * carries `@deepseek-ai/dsh-tools`, so a bare `import` of it makes the injected
 * plugin fail to load. (Verified 2026-10-03: injecting the built `lib/index.js`
 * as-is leaves the loader entry `[no-fiber]`; importing the same file directly
 * under node reports `ERR_MODULE_NOT_FOUND: Cannot find package
 * '@deepseek-ai/dsh-tools'`.)
 *
 * So the boundary lives here instead: the small, pure part of that module which
 * turns an author-facing schema spec into the raw JSON Schema the host's tool
 * registry stores. The translation below is transcribed from the shipped
 * implementation - `@deepseek-ai/dsh-tools`, bundled into
 * `~/.dsh/profiles/desktop/node_modules/@dsh-external/dsh-super-injector/injector/lib/index.js`
 * at `parameterSchemaSpecToJsonSchema` (dist line 4126),
 * `valueSchemaSpecToJsonSchema` (dist line 4116) and `defineTool` (dist line
 * 4153) - and deliberately covers exactly the schema kinds this plugin uses.
 *
 * Adding a schema kind? Re-read that bundle first and extend the `switch` below
 * to match it, rather than assuming the shape.
 *
 * @module @dsh-external/dsh-butler/host/tool-spec
 */

/** A JSON value, as a tool result may contain. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** One block of tool-result content. */
export interface ContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}

/** Arguments as a tool handler sees them. */
export type ToolArgs = Record<string, unknown>

/**
 * A value schema as the model-facing side declares it.
 *
 * `required` here is the JSON Schema array form and only appears on nested
 * object schemas: at the top level of `parameters` a property says
 * {@link ParameterSchemaSpec.required} instead.
 */
export interface ValueSchemaSpec {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json'
  description?: string
  enum?: readonly unknown[]
  items?: ValueSchemaSpec
  properties?: Record<string, ValueSchemaSpec>
  additionalProperties?: boolean
  required?: readonly string[]
  oneOf?: readonly ValueSchemaSpec[]
}

/** One property of the implicit open `parameters` object. */
export type ParameterSchemaSpec = Omit<ValueSchemaSpec, 'required'> & { required?: true }

/** Raw JSON Schema, the shape the host's registry actually stores. */
export interface JsonSchema {
  type?: string
  description?: string
  enum?: readonly unknown[]
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean
  required?: string[]
  oneOf?: JsonSchema[]
}

/** A tool definition as `ctx.tools.register` receives it. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  output: {
    schema: JsonSchema
    render(args: ToolArgs, value: unknown): ContentBlock[]
  }
  timeoutMs?: number
  isConcurrencySafe?(args: ToolArgs): boolean
  execute(args: ToolArgs, exec: unknown): Promise<unknown>
}

/** What {@link defineTool} accepts. */
export interface DefineToolOptions {
  name: string
  description: string
  parameters?: Record<string, ParameterSchemaSpec>
  output: {
    schema: ValueSchemaSpec
    /** Pure formatter: turns the tool's value into content blocks. */
    render(args: ToolArgs, value: unknown): ContentBlock[]
  }
  /** Wall-clock budget the host enforces for one call. */
  timeoutMs?: number
  isConcurrencySafe?(args: ToolArgs): boolean
  execute(args: ToolArgs, exec: unknown): Promise<unknown>
}

/**
 * Compile one value schema to raw JSON Schema.
 * @param spec - the author-facing schema.
 * @returns the raw schema.
 */
function valueSchemaToJsonSchema(spec: ValueSchemaSpec): JsonSchema {
  const schema: JsonSchema = {}
  if (spec.type !== undefined) schema.type = spec.type
  if (spec.description !== undefined) schema.description = spec.description
  if (spec.enum !== undefined) schema.enum = spec.enum
  if (spec.items !== undefined) schema.items = valueSchemaToJsonSchema(spec.items)
  if (spec.oneOf !== undefined) schema.oneOf = spec.oneOf.map(valueSchemaToJsonSchema)
  if (spec.type === 'object') {
    // Nested objects must declare openness: the host refuses a schema that
    // leaves `additionalProperties` implicit.
    schema.additionalProperties = spec.additionalProperties ?? true
  } else if (spec.additionalProperties !== undefined) {
    schema.additionalProperties = spec.additionalProperties
  }
  if (spec.properties !== undefined) {
    const properties: Record<string, JsonSchema> = {}
    for (const [key, value] of Object.entries(spec.properties)) properties[key] = valueSchemaToJsonSchema(value)
    schema.properties = properties
  }
  if (spec.required !== undefined) schema.required = [...spec.required]
  return schema
}

/**
 * Compile the implicit open parameter object.
 * @param spec - per-property definitions.
 * @returns an object-rooted raw schema.
 */
function parametersToJsonSchema(spec: Record<string, ParameterSchemaSpec>): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [key, value] of Object.entries(spec)) {
    if (value.required === true) required.push(key)
    // `required: true` is a parameter-level shorthand; strip it from the
    // property schema so it cannot leak into the nested-object form.
    const { required: _shorthand, ...rest } = value
    properties[key] = valueSchemaToJsonSchema(rest as ValueSchemaSpec)
  }
  return required.length === 0
    ? { type: 'object', properties }
    : { type: 'object', properties, required }
}

/** Invalid model-generated arguments for a typed tool. */
export class ToolArgsError extends Error {
  /** One line per violation. */
  readonly violations: string[]
  readonly toolName?: string
  readonly callId?: string
  /**
   * @param violations - individual violations in schema-walk order.
   */
  constructor(violations: string[], toolName?: string, callId?: string) {
    const identity = toolName === undefined ? '' : ` [tool=${toolName}${callId === undefined ? '' : ` call=${callId}`}]`
    super(`invalid arguments${identity}: ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.violations = violations
    this.toolName = toolName
    this.callId = callId
  }
}

/**
 * Check one value against a raw schema, loosely.
 *
 * Deliberately shallow: the host re-validates with its own compiler, and this
 * only exists so a malformed call fails with a readable message naming the
 * argument instead of reaching a handler that would throw on `undefined`.
 * @param schema - raw schema to check against.
 * @param value - the value to check.
 * @param path - dotted path used in the message.
 * @returns violation lines, empty when the value looks usable.
 */
function checkValue(schema: JsonSchema, value: unknown, path: string): string[] {
  const violations: string[] = []
  switch (schema.type) {
    case undefined:
      break
    case 'string':
      if (typeof value !== 'string') violations.push(`${path}: expected string`)
      break
    case 'number':
      if (typeof value !== 'number') violations.push(`${path}: expected number`)
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) violations.push(`${path}: expected integer`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${path}: expected boolean`)
      break
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${path}: expected array`)
        break
      }
      if (schema.items !== undefined) {
        value.forEach((entry, index) => violations.push(...checkValue(schema.items as JsonSchema, entry, `${path}[${index}]`)))
      }
      break
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        violations.push(`${path}: expected object`)
        break
      }
      const record = value as Record<string, unknown>
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) violations.push(`${path}.${key}: required`)
      }
      const properties = schema.properties ?? {}
      for (const [key, child] of Object.entries(properties)) {
        if (record[key] === undefined) continue
        violations.push(...checkValue(child, record[key], `${path}.${key}`))
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (properties[key] === undefined) violations.push(`${path}.${key}: unexpected property`)
        }
      }
      break
    }
    default:
      break
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    violations.push(`${path}: expected one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
  }
  return violations
}

/**
 * Define a tool with inferred arguments and a checked call boundary.
 * @param options - typed definition and handler.
 * @returns a registry-ready definition.
 */
export function defineTool(options: DefineToolOptions): ToolDefinition {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`)
  }
  const parameters = parametersToJsonSchema(options.parameters ?? {})
  const schema = valueSchemaToJsonSchema(options.output.schema)
  const userExecute = options.execute
  const userRender = options.output.render
  const userIsConcurrencySafe = options.isConcurrencySafe

  const tool: ToolDefinition = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema,
      render: (args, value) => userRender(args, value),
    },
    async execute(args, exec) {
      const violations = checkValue(parameters, args, 'args')
      if (violations.length > 0) {
        const execution = exec !== null && typeof exec === 'object' ? exec as Record<string, unknown> : {}
        const id = execution['callId'] ?? execution['id'] ?? execution['toolCallId']
        throw new ToolArgsError(violations, options.name, typeof id === 'string' ? id : undefined)
      }
      return userExecute(args, exec)
    },
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  if (userIsConcurrencySafe !== undefined) {
    tool.isConcurrencySafe = (args) => (checkValue(parameters, args, 'args').length > 0 ? false : userIsConcurrencySafe(args))
  }
  return tool
}
