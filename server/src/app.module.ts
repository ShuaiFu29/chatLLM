import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { MutationValidationInterceptor } from './common/interceptors/mutation-validation.interceptor';
import { MultipartUploadInterceptor } from './common/interceptors/multipart-upload.interceptor';
import { RuntimeLifecycleService } from './infrastructure/runtime-lifecycle.service';
import { OperationsController } from './modules/operations/operations.controller';
import { AuthModule } from './modules/auth/auth.module';
import { PersonaModule } from './modules/persona/persona.module';
import { ProjectSpacesModule } from './modules/project-spaces/project-spaces.module';
import { PromptTemplatesModule } from './modules/prompt-templates/prompt-templates.module';
import { RagEvalModule } from './modules/rag-eval/rag-eval.module';
import { RagWorkbenchModule } from './modules/rag-workbench/rag-workbench.module';
import { SearchModule } from './modules/search/search.module';
import { UsageModule } from './modules/usage/usage.module';
import { ChatModule } from './modules/chat/chat.module';
import { UploadModule } from './modules/upload/upload.module';
import { AgentsModule } from './modules/agents/agents.module';

@Module({
  imports: [
    AuthModule,
    AgentsModule,
    ChatModule,
    UploadModule,
    PersonaModule,
    ProjectSpacesModule,
    PromptTemplatesModule,
    RagEvalModule,
    RagWorkbenchModule,
    SearchModule,
    UsageModule,
  ],
  controllers: [OperationsController],
  providers: [
    RuntimeLifecycleService,
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: MultipartUploadInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: MutationValidationInterceptor,
    },
  ],
})
export class AppModule {}
