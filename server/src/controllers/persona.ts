import { Request, Response } from 'express';
import {
  getPersonaCenterForUser,
  normalizePersonaProfileUpdate,
  refreshPersonaInsightsForUser,
  resetPersonaCenterForUser,
  updatePersonaInterestStatusForUser,
  updatePersonaProfileForUser,
  updatePersonaSuggestionStatusForUser,
} from '../repositories/persona';

const interestStatuses = new Set(['active', 'accepted', 'hidden', 'rejected']);
const suggestionStatuses = new Set(['active', 'hidden', 'used']);

const readStatus = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export const getPersonaCenter = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const center = await getPersonaCenterForUser(req.user.id);
    res.json(center);
  } catch (error) {
    console.error('Error fetching persona center:', error);
    res.status(500).json({ error: 'Failed to fetch persona center' });
  }
};

export const analyzePersonaCenter = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const center = await refreshPersonaInsightsForUser(req.user.id);
    res.json(center);
  } catch (error) {
    console.error('Error analyzing persona center:', error);
    res.status(500).json({ error: 'Failed to analyze persona center' });
  }
};

export const updatePersonaProfile = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const update = normalizePersonaProfileUpdate(req.body);

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  try {
    const profile = await updatePersonaProfileForUser(req.user.id, update);
    res.json(profile);
  } catch (error) {
    console.error('Error updating persona profile:', error);
    res.status(500).json({ error: 'Failed to update persona profile' });
  }
};

export const updatePersonaInterest = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const status = readStatus(req.body.status);

  if (!interestStatuses.has(status)) {
    return res.status(400).json({ error: 'Invalid interest status' });
  }

  try {
    const interest = await updatePersonaInterestStatusForUser(req.user.id, req.params.interestId, status as 'active' | 'accepted' | 'hidden' | 'rejected');
    if (!interest) return res.status(404).json({ error: 'Interest not found' });
    res.json(interest);
  } catch (error) {
    console.error('Error updating persona interest:', error);
    res.status(500).json({ error: 'Failed to update persona interest' });
  }
};

export const updatePersonaSuggestion = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const status = readStatus(req.body.status);

  if (!suggestionStatuses.has(status)) {
    return res.status(400).json({ error: 'Invalid suggestion status' });
  }

  try {
    const suggestion = await updatePersonaSuggestionStatusForUser(req.user.id, req.params.suggestionId, status as 'active' | 'hidden' | 'used');
    if (!suggestion) return res.status(404).json({ error: 'Suggestion not found' });
    res.json(suggestion);
  } catch (error) {
    console.error('Error updating persona suggestion:', error);
    res.status(500).json({ error: 'Failed to update persona suggestion' });
  }
};

export const resetPersonaCenter = async (req: Request, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const center = await resetPersonaCenterForUser(req.user.id);
    res.json(center);
  } catch (error) {
    console.error('Error resetting persona center:', error);
    res.status(500).json({ error: 'Failed to reset persona center' });
  }
};
