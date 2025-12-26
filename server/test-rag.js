async function test() {
  try {
    console.log('Testing RAG Debug Endpoint...');
    const response = await fetch('http://localhost:3002/api/debug-rag');
    console.log('Status:', response.status);
    const text = await response.text();
    try {
      const json = JSON.parse(text);
      console.log('Data:', JSON.stringify(json, null, 2));
    } catch (e) {
      console.log('Response Text:', text);
    }
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();
