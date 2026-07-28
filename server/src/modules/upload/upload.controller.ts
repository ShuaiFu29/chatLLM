import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import type { BufferedUpload } from '../../common/http/app-request';
import {
  CurrentUser,
  RequestId,
} from '../../common/http/request-context.decorator';
import {
  BufferedUploadFile,
  MultipartUpload,
} from '../../common/interceptors/multipart-upload.interceptor';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { serverEnv } from '../../lib/env';
import { mutationSchemas } from '../../lib/mutationSchemas';
import {
  AVATAR_UPLOAD_LIMIT_BYTES,
  DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES,
} from '../../lib/uploadLimits';
import { User } from '../../types';
import {
  UploadBody,
  UploadQuery,
  UploadService,
} from './upload.service';

@Controller('upload')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'upload',
  max: serverEnv.UPLOAD_RATE_LIMIT_MAX,
  message: 'Too many upload requests',
  skipMethods: ['GET'],
})
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Get('capabilities')
  capabilities() {
    return this.uploadService.getDocumentCapabilities();
  }

  @Post('check')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadCheck)
  check(
    @CurrentUser() user: User,
    @Body() body: UploadBody,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.checkFile(user.id, body, requestId);
  }

  @Post('init')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadInit)
  init(
    @CurrentUser() user: User,
    @Body() body: UploadBody,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.initUpload(user.id, body, requestId);
  }

  @Post('multipart/init')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadMultipartInit)
  initMultipart(
    @CurrentUser() user: User,
    @Body() body: UploadBody,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.initMultipartUpload(user.id, body, requestId);
  }

  @Post('multipart/parts')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadMultipartParts)
  multipartParts(
    @CurrentUser() user: User,
    @Body() body: UploadBody,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.presignMultipartParts(user.id, body, requestId);
  }

  @Post('multipart/complete')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadMultipartComplete)
  completeMultipart(
    @CurrentUser() user: User,
    @Body() body: UploadBody,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.completeMultipartUpload(user.id, body, requestId);
  }

  @Post('multipart/abort')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadMultipartAbort)
  abortMultipart(
    @CurrentUser() user: User,
    @Body() body: UploadBody,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.abortMultipartUpload(user.id, body, requestId);
  }

  @Post('chunk')
  @HttpCode(200)
  @MultipartUpload({
    fieldName: 'chunk',
    maxBytes: DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES,
  })
  @ValidateMutation(mutationSchemas.uploadChunk)
  chunk(
    @CurrentUser() user: User,
    @Body() body: UploadBody,
    @BufferedUploadFile() file: BufferedUpload | undefined,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.uploadChunk(
      user.id,
      body,
      file,
      requestId,
    );
  }

  @Post('merge')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadMerge)
  merge(
    @CurrentUser() user: User,
    @Body() body: UploadBody,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.mergeChunks(user.id, body, requestId);
  }

  @Post('avatar')
  @HttpCode(200)
  @MultipartUpload({
    fieldName: 'file',
    maxBytes: AVATAR_UPLOAD_LIMIT_BYTES,
  })
  @ValidateMutation(mutationSchemas.uploadAvatar)
  avatar(
    @CurrentUser() user: User,
    @BufferedUploadFile() file: BufferedUpload | undefined,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.uploadAvatar(
      user.id,
      file,
      requestId,
    );
  }

  @Get('avatar/:userId')
  getAvatar(
    @CurrentUser() user: User,
    @Param('userId') userId: string,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.getAvatar(user.id, userId, requestId);
  }

  @Get('files')
  files(
    @CurrentUser() user: User,
    @Query() query: UploadQuery,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.listFiles(user.id, query, requestId);
  }

  @Get('files/:id/content')
  fileContent(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.getFileContent(user.id, id, requestId);
  }

  @Get('files/:id/original')
  fileOriginal(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.getFileOriginal(user.id, id, requestId);
  }

  @Post('files/:id/retry')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadRetryFile)
  retryFile(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.retryFileProcessing(user.id, id, requestId);
  }

  @Delete('files/:id')
  @ValidateMutation(mutationSchemas.uploadDeleteFile)
  deleteFile(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @RequestId() requestId?: string,
  ) {
    return this.uploadService.deleteFile(user.id, id, requestId);
  }
}
