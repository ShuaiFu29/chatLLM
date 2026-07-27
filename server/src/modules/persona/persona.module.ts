import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PersonaController } from './persona.controller';
import { PersonaService } from './persona.service';

@Module({
  controllers: [PersonaController],
  providers: [AuthGuard, PersonaService],
})
export class PersonaModule {}
