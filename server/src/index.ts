import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { serverEnv } from './lib/env';
import authRoutes from './routes/auth';
import chatRoutes from './routes/chat';
import uploadRoutes from './routes/upload';
import searchRoutes from './routes/search';
import { fileQueue } from './services/fileQueue';

const app = express();

const PORT = serverEnv.PORT;

const allowedOrigins = [
  serverEnv.FRONTEND_URL,
  'http://localhost:5174'
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/upload', uploadRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  fileQueue.start();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  fileQueue.stop();
  server.close(() => {
    console.log('HTTP server closed');
  });
});
