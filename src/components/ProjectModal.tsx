import React from 'react';
import { ProjectPicker, type ProjectPickerProps } from './ProjectPicker';

export type ProjectModalProps = ProjectPickerProps;

export const ProjectModal: React.FC<ProjectModalProps> = (props) => {
  return <ProjectPicker {...props} isModal={true} />;
};
