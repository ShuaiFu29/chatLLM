// hashWorker.ts
import SparkMD5 from 'spark-md5';

self.onmessage = (e: MessageEvent) => {
  const file = e.data;
  const chunkSize = 2097152; // 2MB
  const chunks = Math.ceil(file.size / chunkSize);
  const spark = new SparkMD5.ArrayBuffer();
  const fileReader = new FileReader();
  let currentChunk = 0;

  fileReader.onload = (e) => {
    if (e.target?.result) {
      spark.append(e.target.result as ArrayBuffer);
    }
    currentChunk++;

    if (currentChunk < chunks) {
      // Report progress
      const progress = Math.round((currentChunk / chunks) * 100);
      self.postMessage({ type: 'progress', progress });
      loadNext();
    } else {
      const hash = spark.end();
      self.postMessage({ type: 'complete', hash });
    }
  };

  fileReader.onerror = () => {
    self.postMessage({ type: 'error', error: 'Hashing failed' });
  };

  function loadNext() {
    const start = currentChunk * chunkSize;
    const end = ((start + chunkSize) >= file.size) ? file.size : start + chunkSize;
    fileReader.readAsArrayBuffer(file.slice(start, end));
  }

  loadNext();
};
