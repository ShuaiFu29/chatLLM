import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  analyzePersonaCenter,
  deletePersonaInterest,
  deletePersonaObservation,
  deletePersonaProfile,
  deletePersonaSuggestion,
  getPersonaCenter,
  resetPersonaCenter,
  updatePersonaInterest,
  updatePersonaObservation,
  updatePersonaProfile,
  updatePersonaSuggestion,
} from '../../controllers/persona';
import { AuthGuard } from '../../common/guards/auth.guard';
import { RateLimitScope } from '../../common/guards/rate-limit.guard';
import { AppReply, AppRequest } from '../../common/http/app-request';
import { ValidateMutation } from '../../common/interceptors/mutation-validation.interceptor';
import { serverEnv } from '../../lib/env';
import { mutationSchemas } from '../../lib/mutationSchemas';

@Controller('persona')
@UseGuards(AuthGuard)
@RateLimitScope({
  keyPrefix: 'persona',
  max: serverEnv.RATE_LIMIT_MAX,
  message: 'Too many persona requests',
})
export class PersonaController {
  @Get()
  get(@Req() request: AppRequest, @Res() reply: AppReply) {
    return getPersonaCenter(request, reply);
  }

  @Post('analyze')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.personaAnalyze)
  analyze(@Req() request: AppRequest, @Res() reply: AppReply) {
    return analyzePersonaCenter(request, reply);
  }

  @Patch('profile')
  @ValidateMutation(mutationSchemas.personaUpdateProfile)
  updateProfile(@Req() request: AppRequest, @Res() reply: AppReply) {
    return updatePersonaProfile(request, reply);
  }

  @Delete('profile')
  @ValidateMutation(mutationSchemas.personaDeleteProfile)
  deleteProfile(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deletePersonaProfile(request, reply);
  }

  @Patch('interests/:interestId')
  @ValidateMutation(mutationSchemas.personaUpdateInterest)
  updateInterest(@Req() request: AppRequest, @Res() reply: AppReply) {
    return updatePersonaInterest(request, reply);
  }

  @Delete('interests/:interestId')
  @ValidateMutation(mutationSchemas.personaDeleteInterest)
  deleteInterest(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deletePersonaInterest(request, reply);
  }

  @Patch('observations/:observationId')
  @ValidateMutation(mutationSchemas.personaUpdateObservation)
  updateObservation(@Req() request: AppRequest, @Res() reply: AppReply) {
    return updatePersonaObservation(request, reply);
  }

  @Delete('observations/:observationId')
  @ValidateMutation(mutationSchemas.personaDeleteObservation)
  deleteObservation(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deletePersonaObservation(request, reply);
  }

  @Patch('suggestions/:suggestionId')
  @ValidateMutation(mutationSchemas.personaUpdateSuggestion)
  updateSuggestion(@Req() request: AppRequest, @Res() reply: AppReply) {
    return updatePersonaSuggestion(request, reply);
  }

  @Delete('suggestions/:suggestionId')
  @ValidateMutation(mutationSchemas.personaDeleteSuggestion)
  deleteSuggestion(@Req() request: AppRequest, @Res() reply: AppReply) {
    return deletePersonaSuggestion(request, reply);
  }

  @Post('reset')
  @HttpCode(200)
  @ValidateMutation(mutationSchemas.personaReset)
  reset(@Req() request: AppRequest, @Res() reply: AppReply) {
    return resetPersonaCenter(request, reply);
  }
}
