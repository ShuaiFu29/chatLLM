import {
  CallHandler,
  createParamDecorator,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MultipartFile } from '@fastify/multipart';
import { from, Observable, switchMap } from 'rxjs';
import { AppRequest, BufferedUpload } from '../http/app-request';

const MULTIPART_UPLOAD = Symbol('chatllm.multipart-upload');

interface MultipartUploadOptions {
  fieldName: string;
  maxBytes: number;
}

export const MultipartUpload = (options: MultipartUploadOptions) => (
  SetMetadata(MULTIPART_UPLOAD, options)
);

export const readBufferedUploadFile = (
  _data: unknown,
  context: ExecutionContext,
): BufferedUpload | undefined => (
  context.switchToHttp().getRequest<AppRequest>().uploadFile
);

export const BufferedUploadFile = createParamDecorator(readBufferedUploadFile);

const toBufferedUpload = async (part: MultipartFile): Promise<BufferedUpload> => {
  const buffer = await part.toBuffer();
  if (part.file.truncated) {
    const error = new Error('Uploaded file is too large') as Error & { code?: string };
    error.code = 'FST_REQ_FILE_TOO_LARGE';
    throw error;
  }

  return {
    fieldname: part.fieldname,
    originalname: part.filename,
    encoding: part.encoding,
    mimetype: part.mimetype,
    size: buffer.byteLength,
    buffer,
  };
};

const parseMultipartUpload = async (
  request: AppRequest,
  options: MultipartUploadOptions,
) => {
  if (!request.isMultipart()) return;

  const body: Record<string, any> = {};
  let file: BufferedUpload | undefined;
  for await (const part of request.parts({
    limits: {
      fileSize: options.maxBytes,
      files: 1,
      fields: 8,
      parts: 9,
    },
  })) {
    if (part.type === 'file') {
      const buffered = await toBufferedUpload(part);
      if (part.fieldname !== options.fieldName) {
        throw new HttpException({ error: 'Unexpected upload field' }, 400);
      }
      file = buffered;
      continue;
    }
    body[part.fieldname] = part.value;
  }

  request.body = body;
  request.uploadFile = file;
};

@Injectable()
export class MultipartUploadInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<MultipartUploadOptions>(MULTIPART_UPLOAD, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return next.handle();

    const request = context.switchToHttp().getRequest<AppRequest>();
    return from(parseMultipartUpload(request, options)).pipe(
      switchMap(() => next.handle()),
    );
  }
}
