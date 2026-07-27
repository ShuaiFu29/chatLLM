import { FastifyReply, FastifyRequest, RequestGenericInterface } from 'fastify';
import { User } from '../../types';

interface AppRequestGeneric extends RequestGenericInterface {
  Body: Record<string, any>;
  Params: Record<string, string>;
  Querystring: Record<string, any>;
}

export interface BufferedUpload {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export type AppRequest = FastifyRequest<AppRequestGeneric> & {
  user?: User;
  requestId?: string;
  file?: BufferedUpload;
};

export type AppReply = FastifyReply;
