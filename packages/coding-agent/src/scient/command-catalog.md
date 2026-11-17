# {{service}} tools

{{description}}

Run `<command> --help` in bash for schema-derived usage. Run `<command> <args>` to call it, or pass JSON with `<command> -j '<json>'`.
Prefer the Scient connector when both it and a ChatGPT account route offer the same capability. Use the ChatGPT account route for capabilities the connector does not offer.

{{#each tools}}
- {{remote}} → `{{name}}` — {{summary}}
{{/each}}
