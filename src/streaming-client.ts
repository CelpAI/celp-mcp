// Example client for using the streaming endpoint from another TypeScript project
// This can be used as a reference for how to connect to the streaming API

/**
 * Database connection configuration
 */
interface DatabaseConnection {
  host: string;
  user: string;
  password: string;
  database: string;
  port?: number;
  databaseType: 'postgres' | 'mysql';
}

/**
 * Client class for interacting with the streaming database query endpoint
 */
export class StreamingDatabaseClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  
  /**
   * Create a new client instance
   * @param baseUrl Base URL of the API server (e.g., 'http://localhost:3000')
   * @param apiKey API key for authentication
   */
  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    this.apiKey = apiKey;
  }

  /**
   * Query the database with streaming results
   * @param prompt User prompt/question to analyze
   * @param databaseConnection Database connection details
   * @param callbacks Callbacks for handling streaming events
   * @returns A promise that resolves when the stream ends
   */
  async queryDatabase(
    prompt: string,
    databaseConnection: DatabaseConnection,
    callbacks: {
      onProgress?: (data: any) => void;
      onFinalReport?: (report: string) => void;
      onFinalMarkdown?: (markdown: string) => void;
      onError?: (error: Error) => void;
      onDone?: () => void;
    }
  ): Promise<void> {
    try {
      // Prepare the EventSource URL
      const url = `${this.baseUrl}/api/streaming/query-database`;
      
      // Make the POST request to initialize the streaming connection
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          prompt,
          databaseConnection,
          apiKey: this.apiKey,
        }),
      });
      
      // Check if the response is OK
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to initialize streaming: ${response.status} ${errorText}`);
      }
      
      // Handle the stream (SSE) from the response
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Response body is not readable');
      }
      
      // Process the stream
      const decoder = new TextDecoder();
      let buffer = '';
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        // Convert chunk to text and add to buffer
        buffer += decoder.decode(value, { stream: true });
        
        // Process complete SSE messages
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data:')) continue;
          
          try {
            // Extract and parse the JSON data
            const data = JSON.parse(line.substring(5).trim());
            
            // Handle different event types
            switch (data.type) {
              case 'FINAL_MARKDOWN_REPORT':
                callbacks.onFinalReport?.(data.data);
                break;
              case 'FINAL_MARKDOWN':
                callbacks.onFinalMarkdown?.(data.data);
                break;
              case 'ERROR':
                callbacks.onError?.(new Error(data.data));
                break;
              case 'DONE':
                callbacks.onDone?.();
                break;
              default:
                // Send progress updates
                callbacks.onProgress?.(data);
            }
          } catch (err) {
            console.error('Error parsing SSE message:', err, line);
          }
        }
      }
    } catch (error) {
      callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

// Example usage
async function exampleUsage() {
  // Create a client instance
  const client = new StreamingDatabaseClient(
    'http://localhost:3000',
    'your-api-key-here'
  );
  
  // Example database connection
  const dbConnection: DatabaseConnection = {
    host: 'localhost',
    user: 'dbuser',
    password: 'dbpassword',
    database: 'mydb',
    databaseType: 'postgres',
  };
  
  // Query with streaming results
  await client.queryDatabase(
    'What are the top 10 customers by revenue?',
    dbConnection,
    {
      onProgress: (data) => {
        console.log('Progress:', data);
      },
      onFinalReport: (report) => {
        console.log('Final Report:', report);
      },
      onFinalMarkdown: (markdown) => {
        console.log('Final Markdown:', markdown);
      },
      onError: (error) => {
        console.error('Error:', error);
      },
      onDone: () => {
        console.log('Query completed');
      },
    }
  );
}

// Run the example if this file is executed directly
if (require.main === module) {
  exampleUsage().catch(console.error);
} 