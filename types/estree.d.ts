import 'estree';

declare module 'estree' {
    // For some reason this isn't part of @types/estree
    export interface BaseNodeWithoutComments {
        start: number;
        end: number;
    }
}
export {};
