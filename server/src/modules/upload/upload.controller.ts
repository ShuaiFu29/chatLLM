import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import { AppReply, AppRequest } from '../../common/http/app-request';
import { MultipartUpload } from '../../common/interceptors/multipart-upload.interceptor';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import {
  abortMultipartUpload,
  checkFile,
  completeMultipartUpload,
  deleteFile,
  getAvatar,
  getFileContent,
  initMultipartUpload,
  initUpload,
  listFiles,
  mergeChunks,
  presignMultipartParts,
  retryFileProcessing,
  uploadAvatar,
  uploadChunk,
} from '../../controllers/upload';
import { serverEnv } from '../../lib/env';
import { mutationSchemas } from '../../lib/mutationSchemas';
import {
  AVATAR_UPLOAD_LIMIT_BYTES,
  DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES,
} from '../../lib/uploadLimits';

@Controller('upload')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'upload',
  max: serverEnv.UPLOAD_RATE_LIMIT_MAX,
  message: 'Too many upload requests',
  skipMethods: ['GET'],
})
export class UploadController {
  @Post('check')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadCheck)
  check(@Req() request: AppRequest, @Res() reply: AppReply) {
    return checkFile(request, reply);
  }

  @Post('init')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadInit)
  init(@Req() request: AppRequest, @Res() reply: AppReply) {
    return initUpload(request, reply);
  }

  @Post('multipart/init')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadMultipartInit)
  initMultipart(@Req() request: AppRequest, @Res() reply: AppReply) {
    return initMultipartUpload(request, reply);
  }

  @Post('multipart/parts')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadMultipartParts)
  multipartParts(@Req() request: AppRequest, @Res() reply: AppReply) {
    return presignMultipartParts(request, reply);
  }

  @Post('multipart/complete')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadMultipartComplete)
  completeMultipart(@Req() request: AppRequest, @Res() reply: AppReply) {
    return completeMultipartUpload(request, reply);
  }

  @Post('multipart/abort')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadMultipartAbort)
  abortMultipart(@Req() request: AppRequest, @Res() reply: AppReply) {
    return abortMultipartUpload(request, reply);
  }

  @Post('chunk')
  @HttpCode(200)
  @MultipartUpload({
    fieldName: 'chunk',
    maxBytes: DOCUMENT_CHUNK_UPLOAD_LIMIT_BYTES,
  })
  @ValidateMutation(mutationSchemas.uploadChunk)
  chunk(@Req() request: AppRequest, @Res() reply: AppReply) {
    return uploadChunk(request, reply);
  }

  @Post('merge')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadMerge)
  merge(@Req() request: AppRequest, @Res() reply: AppReply) {
    return mergeChunks(request, reply);
  }

  @Post('avatar')
  @HttpCode(200)
  @MultipartUpload({
    fieldName: 'file',
    maxBytes: AVATAR_UPLOAD_LIMIT_BYTES,
  })
  @ValidateMutation(mutationSchemas.uploadAvatar)
  avatar(@Req() request: AppRequest, @Res() reply: AppReply) {
    return uploadAvatar(request, reply);
  }

  @Get('avatar/:userId')
  getAvatar(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getAvatar(request, reply);
  }

  @Get('files')
  files(@Req() request: AppRequest, @Res() reply: AppReply) {
    return listFiles(request, reply);
  }

  @Get('files/:id/content')
  fileContent(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getFileContent(request, reply);
  }

  @Post('files/:id/retry')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.uploadRetryFile)
  retryFile(@Req() request: AppRequest, @Res() reply: AppReply) {
    return retryFileProcessing(request, reply);
  }

  @Delete('files/:id')
  @ValidateMutation(mutationSchemas.uploadDeleteFile)
  deleteFile(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deleteFile(request, reply);
  }
}
