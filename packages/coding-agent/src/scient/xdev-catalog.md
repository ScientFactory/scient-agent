# {{service}} tools

{{description}}

Choose a tool, then read its exact xd:// path for the full docs and JSON schema before first use.
Execute it by writing the JSON arguments to that same path. This service catalog is read-only.
When both a Scient connector and a ChatGPT account route are available, prefer the Scient connector.
Use the ChatGPT account route for capabilities the connector does not offer.

{{#each tools}}
- {{remote}} → xd://{{name}} — {{summary}}
{{/each}}
