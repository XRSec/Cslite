import { CsliteClient } from './client';
import { createMcpServer, startStdioServer } from './server';

function main(): void {
  const baseUrl = (process.env.CSLITE_URL || process.env.CSLITE_SERVER || '').trim();
  const apiKey = (process.env.CSLITE_API_KEY || '').trim();

  if (!baseUrl || !apiKey) {
    process.stderr.write(
      'cslite-mcp error: CSLITE_URL and CSLITE_API_KEY environment variables are required.\n',
    );
    process.exit(1);
  }

  const client = new CsliteClient({ baseUrl, apiKey });
  const server = createMcpServer(client);
  startStdioServer(server);
}

main();
