import { HttpException, Injectable } from '@nestjs/common';
import { toSafeError } from '../../lib/safeError';
import {
  deletePersonaInterestForUser,
  deletePersonaObservationForUser,
  deletePersonaProfileForUser,
  deletePersonaSuggestionForUser,
  getPersonaCenterForUser,
  normalizePersonaProfileUpdate,
  refreshPersonaInsightsForUser,
  resetPersonaCenterForUser,
  updatePersonaInterestStatusForUser,
  updatePersonaObservationStatusForUser,
  updatePersonaProfileForUser,
  updatePersonaSuggestionStatusForUser,
} from '../../repositories/persona';

type PersonaBody = Record<string, unknown>;

const interestStatuses = new Set(['active', 'accepted', 'hidden', 'rejected']);
const observationStatuses = new Set(['active', 'accepted', 'hidden', 'rejected']);
const suggestionStatuses = new Set(['active', 'hidden', 'used', 'rejected']);

const readStatus = (value: unknown) => (
  typeof value === 'string' ? value.trim() : ''
);

const requestError = (status: number, error: string) => (
  new HttpException({ error }, status)
);

@Injectable()
export class PersonaService {
  async get(userId: string, requestId?: string) {
    try {
      return await getPersonaCenterForUser(userId);
    } catch (error) {
      console.error('Error fetching persona center:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to fetch persona center');
    }
  }

  async analyze(userId: string, requestId?: string) {
    try {
      return await refreshPersonaInsightsForUser(userId);
    } catch (error) {
      console.error('Error analyzing persona center:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to analyze persona center');
    }
  }

  async updateProfile(userId: string, body: PersonaBody, requestId?: string) {
    const update = normalizePersonaProfileUpdate(body);
    if (Object.keys(update).length === 0) {
      throw requestError(400, 'No fields to update');
    }

    try {
      return await updatePersonaProfileForUser(userId, update);
    } catch (error) {
      console.error('Error updating persona profile:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to update persona profile');
    }
  }

  async updateInterest(
    userId: string,
    interestId: string,
    statusValue: unknown,
    requestId?: string,
  ) {
    const status = readStatus(statusValue);
    if (!interestStatuses.has(status)) {
      throw requestError(400, 'Invalid interest status');
    }

    try {
      const interest = await updatePersonaInterestStatusForUser(
        userId,
        interestId,
        status as 'active' | 'accepted' | 'hidden' | 'rejected',
      );
      if (!interest) throw requestError(404, 'Interest not found');
      return interest;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error updating persona interest:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to update persona interest');
    }
  }

  async updateObservation(
    userId: string,
    observationId: string,
    statusValue: unknown,
    requestId?: string,
  ) {
    const status = readStatus(statusValue);
    if (!observationStatuses.has(status)) {
      throw requestError(400, 'Invalid observation status');
    }

    try {
      const observation = await updatePersonaObservationStatusForUser(
        userId,
        observationId,
        status as 'active' | 'accepted' | 'hidden' | 'rejected',
      );
      if (!observation) throw requestError(404, 'Observation not found');
      return observation;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error updating persona observation:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to update persona observation');
    }
  }

  async updateSuggestion(
    userId: string,
    suggestionId: string,
    statusValue: unknown,
    requestId?: string,
  ) {
    const status = readStatus(statusValue);
    if (!suggestionStatuses.has(status)) {
      throw requestError(400, 'Invalid suggestion status');
    }

    try {
      const suggestion = await updatePersonaSuggestionStatusForUser(
        userId,
        suggestionId,
        status as 'active' | 'hidden' | 'used' | 'rejected',
      );
      if (!suggestion) throw requestError(404, 'Suggestion not found');
      return suggestion;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error updating persona suggestion:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to update persona suggestion');
    }
  }

  async deleteProfile(userId: string, requestId?: string) {
    try {
      return await deletePersonaProfileForUser(userId);
    } catch (error) {
      console.error('Error deleting persona profile:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to delete persona profile');
    }
  }

  async deleteInterest(userId: string, interestId: string, requestId?: string) {
    try {
      const interest = await deletePersonaInterestForUser(userId, interestId);
      if (!interest) throw requestError(404, 'Interest not found');
      return interest;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error deleting persona interest:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to delete persona interest');
    }
  }

  async deleteObservation(userId: string, observationId: string, requestId?: string) {
    try {
      const observation = await deletePersonaObservationForUser(userId, observationId);
      if (!observation) throw requestError(404, 'Observation not found');
      return observation;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error deleting persona observation:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to delete persona observation');
    }
  }

  async deleteSuggestion(userId: string, suggestionId: string, requestId?: string) {
    try {
      const suggestion = await deletePersonaSuggestionForUser(userId, suggestionId);
      if (!suggestion) throw requestError(404, 'Suggestion not found');
      return suggestion;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      console.error('Error deleting persona suggestion:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to delete persona suggestion');
    }
  }

  async reset(userId: string, requestId?: string) {
    try {
      return await resetPersonaCenterForUser(userId);
    } catch (error) {
      console.error('Error resetting persona center:', toSafeError(error, requestId));
      throw requestError(500, 'Failed to reset persona center');
    }
  }
}
