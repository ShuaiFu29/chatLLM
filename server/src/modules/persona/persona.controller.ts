import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import { CurrentUser, RequestId } from '../../common/http/request-context.decorator';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { serverEnv } from '../../lib/env';
import { mutationSchemas } from '../../lib/mutationSchemas';
import { User } from '../../types';
import { PersonaService } from './persona.service';

@Controller('persona')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'persona',
  max: serverEnv.RATE_LIMIT_MAX,
  message: 'Too many persona requests',
})
export class PersonaController {
  constructor(private readonly personaService: PersonaService) {}

  @Get()
  get(@CurrentUser() user: User, @RequestId() requestId?: string) {
    return this.personaService.get(user.id, requestId);
  }

  @Post('analyze')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.personaAnalyze)
  analyze(@CurrentUser() user: User, @RequestId() requestId?: string) {
    return this.personaService.analyze(user.id, requestId);
  }

  @Patch('profile')
  @ValidateMutation(mutationSchemas.personaUpdateProfile)
  updateProfile(
    @CurrentUser() user: User,
    @Body() body: Record<string, unknown>,
    @RequestId() requestId?: string,
  ) {
    return this.personaService.updateProfile(user.id, body, requestId);
  }

  @Delete('profile')
  @ValidateMutation(mutationSchemas.personaDeleteProfile)
  deleteProfile(@CurrentUser() user: User, @RequestId() requestId?: string) {
    return this.personaService.deleteProfile(user.id, requestId);
  }

  @Patch('interests/:interestId')
  @ValidateMutation(mutationSchemas.personaUpdateInterest)
  updateInterest(
    @CurrentUser() user: User,
    @Param('interestId') interestId: string,
    @Body('status') status: unknown,
    @RequestId() requestId?: string,
  ) {
    return this.personaService.updateInterest(user.id, interestId, status, requestId);
  }

  @Delete('interests/:interestId')
  @ValidateMutation(mutationSchemas.personaDeleteInterest)
  deleteInterest(
    @CurrentUser() user: User,
    @Param('interestId') interestId: string,
    @RequestId() requestId?: string,
  ) {
    return this.personaService.deleteInterest(user.id, interestId, requestId);
  }

  @Patch('observations/:observationId')
  @ValidateMutation(mutationSchemas.personaUpdateObservation)
  updateObservation(
    @CurrentUser() user: User,
    @Param('observationId') observationId: string,
    @Body('status') status: unknown,
    @RequestId() requestId?: string,
  ) {
    return this.personaService.updateObservation(user.id, observationId, status, requestId);
  }

  @Delete('observations/:observationId')
  @ValidateMutation(mutationSchemas.personaDeleteObservation)
  deleteObservation(
    @CurrentUser() user: User,
    @Param('observationId') observationId: string,
    @RequestId() requestId?: string,
  ) {
    return this.personaService.deleteObservation(user.id, observationId, requestId);
  }

  @Patch('suggestions/:suggestionId')
  @ValidateMutation(mutationSchemas.personaUpdateSuggestion)
  updateSuggestion(
    @CurrentUser() user: User,
    @Param('suggestionId') suggestionId: string,
    @Body('status') status: unknown,
    @RequestId() requestId?: string,
  ) {
    return this.personaService.updateSuggestion(user.id, suggestionId, status, requestId);
  }

  @Delete('suggestions/:suggestionId')
  @ValidateMutation(mutationSchemas.personaDeleteSuggestion)
  deleteSuggestion(
    @CurrentUser() user: User,
    @Param('suggestionId') suggestionId: string,
    @RequestId() requestId?: string,
  ) {
    return this.personaService.deleteSuggestion(user.id, suggestionId, requestId);
  }

  @Post('reset')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.personaReset)
  reset(@CurrentUser() user: User, @RequestId() requestId?: string) {
    return this.personaService.reset(user.id, requestId);
  }
}
