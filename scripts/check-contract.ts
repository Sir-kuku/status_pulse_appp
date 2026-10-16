import SwaggerParser from '@apidevtools/swagger-parser';

const spec = await SwaggerParser.validate('docs/openapi.json');
console.log(`OpenAPI contract is valid: ${Object.keys(spec.paths ?? {}).length} documented paths.`);
