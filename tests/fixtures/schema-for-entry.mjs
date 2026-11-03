// Only configuration construction is stubbed; lifecycle tests pass explicit config.
// Keep every factory the real schemastery exposes for the plugin's Config schema
// (string/number/boolean/object/array) so importing src/index.ts stays possible.
const scalar = () => ({ min() { return this }, max() { return this }, default() { return this } })
const boolean = () => ({ default() { return this } })
const array = () => ({ default() { return this } })
const object = shape => ({ ...shape, description() { return this } })
export default { object, string: scalar, number: scalar, boolean, array }
