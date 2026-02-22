declare module "input" {
  const input: {
    text(prompt: string): Promise<string>;
    confirm(prompt: string): Promise<boolean>;
  };
  export default input;
}
