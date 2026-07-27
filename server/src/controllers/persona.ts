import { AppReply, AppRequest } from '../common/http/app-request';
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
} from '../repositories/persona';
import { toSafeError } from '../lib/safeError';

const interestStatuses = new Set(['active', 'accepted', 'hidden', 'rejected']);
const observationStatuses = new Set(['active', 'accepted', 'hidden', 'rejected']);
const suggestionStatuses = new Set(['active', 'hidden', 'used', 'rejected']);

const readStatus = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export const getPersonaCenter = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const center = await getPersonaCenterForUser(req.user.id);
    res.send(center);
  } catch (error) {
    console.error('Error fetching persona center:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to fetch persona center' });
  }
};

export const analyzePersonaCenter = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const center = await refreshPersonaInsightsForUser(req.user.id);
    res.send(center);
  } catch (error) {
    console.error('Error analyzing persona center:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to analyze persona center' });
  }
};

export const updatePersonaProfile = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const update = normalizePersonaProfileUpdate(req.body);

  if (Object.keys(update).length === 0) {
    return res.code(400).send({ error: 'No fields to update' });
  }

  try {
    const profile = await updatePersonaProfileForUser(req.user.id, update);
    res.send(profile);
  } catch (error) {
    console.error('Error updating persona profile:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to update persona profile' });
  }
};

export const updatePersonaInterest = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const status = readStatus(req.body.status);

  if (!interestStatuses.has(status)) {
    return res.code(400).send({ error: 'Invalid interest status' });
  }

  try {
    const interest = await updatePersonaInterestStatusForUser(req.user.id, req.params.interestId, status as 'active' | 'accepted' | 'hidden' | 'rejected');
    if (!interest) return res.code(404).send({ error: 'Interest not found' });
    res.send(interest);
  } catch (error) {
    console.error('Error updating persona interest:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to update persona interest' });
  }
};

export const updatePersonaObservation = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const status = readStatus(req.body.status);

  if (!observationStatuses.has(status)) {
    return res.code(400).send({ error: 'Invalid observation status' });
  }

  try {
    const observation = await updatePersonaObservationStatusForUser(req.user.id, req.params.observationId, status as 'active' | 'accepted' | 'hidden' | 'rejected');
    if (!observation) return res.code(404).send({ error: 'Observation not found' });
    res.send(observation);
  } catch (error) {
    console.error('Error updating persona observation:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to update persona observation' });
  }
};

export const updatePersonaSuggestion = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });
  const status = readStatus(req.body.status);

  if (!suggestionStatuses.has(status)) {
    return res.code(400).send({ error: 'Invalid suggestion status' });
  }

  try {
    const suggestion = await updatePersonaSuggestionStatusForUser(req.user.id, req.params.suggestionId, status as 'active' | 'hidden' | 'used' | 'rejected');
    if (!suggestion) return res.code(404).send({ error: 'Suggestion not found' });
    res.send(suggestion);
  } catch (error) {
    console.error('Error updating persona suggestion:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to update persona suggestion' });
  }
};

export const deletePersonaProfile = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const center = await deletePersonaProfileForUser(req.user.id);
    res.send(center);
  } catch (error) {
    console.error('Error deleting persona profile:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to delete persona profile' });
  }
};

export const deletePersonaInterest = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const interest = await deletePersonaInterestForUser(req.user.id, req.params.interestId);
    if (!interest) return res.code(404).send({ error: 'Interest not found' });
    res.send(interest);
  } catch (error) {
    console.error('Error deleting persona interest:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to delete persona interest' });
  }
};

export const deletePersonaObservation = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const observation = await deletePersonaObservationForUser(req.user.id, req.params.observationId);
    if (!observation) return res.code(404).send({ error: 'Observation not found' });
    res.send(observation);
  } catch (error) {
    console.error('Error deleting persona observation:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to delete persona observation' });
  }
};

export const deletePersonaSuggestion = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const suggestion = await deletePersonaSuggestionForUser(req.user.id, req.params.suggestionId);
    if (!suggestion) return res.code(404).send({ error: 'Suggestion not found' });
    res.send(suggestion);
  } catch (error) {
    console.error('Error deleting persona suggestion:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to delete persona suggestion' });
  }
};

export const resetPersonaCenter = async (req: AppRequest, res: AppReply) => {
  if (!req.user) return res.code(401).send({ error: 'Unauthorized' });

  try {
    const center = await resetPersonaCenterForUser(req.user.id);
    res.send(center);
  } catch (error) {
    console.error('Error resetting persona center:', toSafeError(error, req.requestId));
    res.code(500).send({ error: 'Failed to reset persona center' });
  }
};
