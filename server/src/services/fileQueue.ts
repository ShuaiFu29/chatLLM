import { supabaseAdmin } from '../lib/supabase';
import axios from 'axios';

class FileQueueService {
  private isProcessing = false;
  private interval: NodeJS.Timeout | null = null;
  private ragServiceUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';

  start() {
    if (this.interval) return;
    this.processNextFile();
    this.interval = setInterval(() => this.processNextFile(), 5000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  trigger() {
    this.processNextFile();
  }

  private async processNextFile() {
    if (this.isProcessing) return;

    try {
      const { data: files, error } = await supabaseAdmin
        .from('files')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1);

      if (error) {
        return;
      }

      if (!files || files.length === 0) {
        return;
      }

      const file = files[0];
      this.isProcessing = true;

      try {
        await axios.post(`${this.ragServiceUrl}/ingest`, {
          file_id: file.id
        });

        await supabaseAdmin.from('files').update({ status: 'processing' }).eq('id', file.id);

      } catch (err: any) {
        await supabaseAdmin.from('files').update({
          status: 'failed',
          error_message: `RAG Service unavailable: ${err.message}`
        }).eq('id', file.id);
      }

    } catch (err) {
      // Silent fail
    } finally {
      this.isProcessing = false;
    }
  }
}

export const fileQueue = new FileQueueService();
