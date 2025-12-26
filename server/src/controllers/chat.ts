import { Request, Response } from 'express';
import axios from 'axios';
import { supabase } from '../lib/supabase';
import { openai, getEmbedding } from '../lib/openai';
import dotenv from 'dotenv';

dotenv.config();

// Get all conversations for current user
export const getConversations = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('user_id', req.user.id)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('Error fetching conversations:', error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
    return;
  }

  res.json(data);
};

// Search messages
export const searchMessages = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { q } = req.query;

  if (!q || typeof q !== 'string') {
    res.status(400).json({ error: 'Search query is required' });
    return;
  }

  // Use ILIKE for case-insensitive search
  // Join with conversations to ensure we only search user's conversations and get titles
  const { data, error } = await supabase
    .from('messages')
    .select(`
      id,
      content,
      created_at,
      conversation_id,
      conversations!inner (
        id,
        title,
        user_id
      )
    `)
    .eq('conversations.user_id', req.user.id)
    .ilike('content', `%${q}%`)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    res.status(500).json({ error: 'Failed to search messages' });
    return;
  }

  res.json(data);
};

// Create a new conversation
export const createConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { title } = req.body;

  const { data: conversation, error } = await supabase
    .from('conversations')
    .insert({
      user_id: req.user.id,
      title: title || 'New Chat'
    })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: 'Failed to create conversation' });
    return;
  }

  res.json(conversation);
};

// Update conversation (e.g. rename or update settings)
export const updateConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const { title, model, temperature, system_prompt, enable_rag } = req.body;

  // Build updates object dynamically
  const updates: any = { updated_at: new Date().toISOString() };
  if (title !== undefined) updates.title = title;
  if (model !== undefined) updates.model = model;
  if (temperature !== undefined) updates.temperature = temperature;
  if (system_prompt !== undefined) updates.system_prompt = system_prompt;
  if (enable_rag !== undefined) updates.enable_rag = enable_rag;

  if (Object.keys(updates).length <= 1) { // Only updated_at
    return res.status(400).json({ error: 'No fields to update' });
  }

  // Verify ownership and update
  const { data, error } = await supabase
    .from('conversations')
    .update(updates)
    .eq('id', conversationId)
    .eq('user_id', req.user.id) // Ensure ownership
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: 'Failed to update conversation' });
    return;
  }

  res.json(data);
};

// Delete a conversation
export const deleteConversation = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId } = req.params;

  // Verify ownership and delete
  const { error } = await supabase
    .from('conversations')
    .delete()
    .eq('id', conversationId)
    .eq('user_id', req.user.id); // Ensure ownership

  if (error) {
    res.status(500).json({ error: 'Failed to delete conversation' });
    return;
  }

  res.json({ success: true });
};

// Delete a single message
export const deleteMessage = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { messageId } = req.params;

  // 1. Get the message to find its conversation_id
  const { data: message, error: fetchError } = await supabase
    .from('messages')
    .select('conversation_id')
    .eq('id', messageId)
    .single();

  if (fetchError || !message) {
    res.status(404).json({ error: 'Message not found' });
    return;
  }

  // 2. Verify user owns the conversation
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('id')
    .eq('id', message.conversation_id)
    .eq('user_id', req.user.id)
    .single();

  if (convError || !conversation) {
    res.status(403).json({ error: 'Unauthorized to delete this message' });
    return;
  }

  // 3. Delete the message
  const { error: deleteError } = await supabase
    .from('messages')
    .delete()
    .eq('id', messageId);

  if (deleteError) {
    res.status(500).json({ error: 'Failed to delete message' });
    return;
  }

  res.json({ success: true });
};

const generateConversationTitle = async (conversationId: string, firstMessage: string) => {
  try {
    const response = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        {
          role: "system",
          content: "Generate a short, concise title (maximum 5 words) for a conversation based on the following user message. The title should be in the same language as the user message. Do not use quotes. Return ONLY the title."
        },
        { role: "user", content: firstMessage }
      ],
      max_tokens: 20,
      temperature: 0.7
    });

    const title = response.choices[0]?.message?.content?.trim();
    if (title) {
      await supabase
        .from('conversations')
        .update({ title })
        .eq('id', conversationId);
    }
  } catch (error) {
    // Silent fail for title generation
  }
};

// Get messages for a conversation
export const getMessages = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId } = req.params;

  // Verify ownership
  const { data: conversation } = await supabase
    .from('conversations')
    .select('user_id')
    .eq('id', conversationId)
    .single();

  if (!conversation || conversation.user_id !== req.user.id) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) {
    res.status(500).json({ error: 'Failed to fetch messages' });
    return;
  }

  res.json(data);
};

// Send a message (User -> Assistant) with Streaming
export const sendMessage = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const { conversationId } = req.params;
  const { content } = req.body;

  if (!content) {
    res.status(400).json({ error: 'Content is required' });
    return;
  }

  // Start parallel operations: Save message, Fetch settings, Fetch history
  const [insertResult, conversationResult, historyResult] = await Promise.all([
    // 1. Save user message to DB
    supabase
      .from('messages')
      .insert({
        conversation_id: conversationId,
        role: 'user',
        content
      }),

    // 2. Fetch conversation settings
    supabase
      .from('conversations')
      .select('title, model, temperature, system_prompt, enable_rag')
      .eq('id', conversationId)
      .single(),

    // 3. Get chat history context (last 10 messages)
    supabase
      .from('messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(10)
  ]);

  // Check for insert errors
  if (insertResult.error) {
    res.status(500).json({ error: 'Failed to save message' });
    return;
  }

  const conversation = conversationResult.data;

  // Handle Title Generation (Fire and Forget)
  if (conversation && conversation.title === 'New Chat') {
    generateConversationTitle(conversationId, content);
  }

  // Update timestamp (Fire and Forget)
  supabase
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId)
    .then(({ error }) => {
      // Silent error
    });

  // 3. Setup SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  try {
    // 4. Get Conversation Settings
    let model = conversation?.model || "deepseek-chat";
    let temperature = conversation?.temperature !== undefined ? conversation.temperature : 0.7;
    let systemPrompt = conversation?.system_prompt || "You are a helpful AI assistant.";
    let enableRag = conversation?.enable_rag !== undefined ? conversation.enable_rag : true;

    // 5. RAG: Retrieve relevant context
    let contextText = '';
    const ragServiceUrl = process.env.RAG_SERVICE_URL || 'http://localhost:8000';

    if (enableRag) {
      try {
        const payload = {
          query: content,
          user_id: String(req.user.id || ''),
          limit: 10,
          threshold: 0.1
        };

        const ragResponse = await axios.post(`${ragServiceUrl}/retrieve`, payload);
        const documents = ragResponse.data.results;

        if (documents && documents.length > 0) {
          contextText = documents.map((doc: any) => doc.content).join('\n---\n');

          const sources = documents.map((doc: any) => ({
            filename: doc.metadata.filename,
            similarity: doc.similarity
          }));
          res.write(`data: ${JSON.stringify({ sources })}\n\n`);
        }
      } catch (err: any) {
        // Silent fail
      }
    }

    // Prepare messages for LLM
    const history = historyResult.data || [];
    let messages = history.reverse().map(msg => ({
      role: msg.role as 'user' | 'assistant' | 'system',
      content: msg.content
    }));

    // Ensure the last message is the current user's message
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== content) {
      messages.push({ role: 'user', content });
    }

    if (contextText) {
      const lastMsgIndex = messages.length - 1;
      if (lastMsgIndex >= 0 && messages[lastMsgIndex].role === 'user') {
        const originalContent = messages[lastMsgIndex].content;
        messages[lastMsgIndex].content = `Based on the following context, please answer the user's question.
If the answer is not in the context, say so, but you can still use your general knowledge.
Do not mention "Based on the provided context" or similar phrases in your answer unless necessary to clarify sources.

Context:
${contextText}

Question:
${originalContent}`;
      }
    }

    // 7. Call LLM API with streaming
    const stream = await openai.chat.completions.create({
      model: model, // Use user preference
      messages: [
        { role: "system", content: systemPrompt },
        ...messages
      ],
      stream: true,
      temperature: temperature, // Use user preference
    });

    let fullContent = '';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content || '';
      if (delta) {
        fullContent += delta;
        // Send SSE event
        res.write(`data: ${JSON.stringify({ content: delta })}\n\n`);
      }
    }

    // 8. Save AI response to DB after stream finishes
    if (fullContent) {
      await supabase
        .from('messages')
        .insert({
          conversation_id: conversationId,
          role: 'assistant',
          content: fullContent
        });
    }

    // End stream
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    // If headers already sent, we can only send an error event
    res.write(`data: ${JSON.stringify({ error: 'Failed to generate response' })}\n\n`);
    res.end();
  }
};
