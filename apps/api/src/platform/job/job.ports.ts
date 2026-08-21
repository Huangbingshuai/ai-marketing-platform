export type JobMessage = {
  schemaVersion: number;
  projectId: string;
  runId: string;
  requestId: string;
};

export interface JobPublisher {
  publish(queue: string, messageId: string, payload: JobMessage): Promise<void>;
}

export type JobProgress = {
  runId: string;
  projectId: string;
  progress: number;
  currentNode: string | null;
  updatedAt: string;
};

export interface JobProgressStore {
  get(projectId: string, runId: string): Promise<JobProgress | null>;
  set(progress: JobProgress): Promise<void>;
  delete(projectId: string, runId: string): Promise<void>;
}
