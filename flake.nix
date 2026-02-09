{
  description = "flake for keybr.com";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        packages = with pkgs; [
          nodejs
        ];

        # Create shell scripts
        # scripts = [
        #   (pkgs.writeScriptBin "km" ''
        #     ./visual-keymap.sh
        #   '')
        #   (pkgs.writeScriptBin "live-reload" ''
        #     echo "zsa_voyager_keymap.yaml keychron_q12_keymap.yaml" | tr ' ' '\n' | ${pkgs.entr}/bin/entr sh ./visual-keymap.sh
        #   '')
        # ];
        # Create shell scripts
        scripts = [
          (pkgs.writeScriptBin "go" ''
            npm start
          '')
        ];
      in
        {
          # For nix develop
          devShells = {
            default = pkgs.mkShell {
              packages = packages ++ scripts;
            };
          };

          # For nix shell
          packages = {
            default = pkgs.buildEnv {
              name = "keybr.com";
              paths = packages ++ scripts;
            };
          };
        });
}
