import { createContext, useContext } from 'react';

/**
 * Id of the newest tool call in the current step group while that group is running, else null.
 * ToolCallCard uses it as its default open state; see StepGroup.tsx.
 */
export const LatestStepContext = createContext<string | null>(null);
export const useLatestStepId = () => useContext(LatestStepContext);
