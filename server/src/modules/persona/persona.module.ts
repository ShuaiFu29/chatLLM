import { Module } from '@nestjs/common';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PersonaController } from './persona.controller';

@Module({
  controllers: [PersonaController],
  providers: [AuthGuard],
})
export class PersonaModule {}
