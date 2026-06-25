# GitHub Read/Write Split Access Setup

## Configure git

```
git config --global user.name "username"
git config --global user.email "email"
```

## Create a Personal Acceess Token

Create a classic token at https://github.com/settings/tokens

## Install gh CLI and use auth command

```
sudo apt update
sudo apt install gh -y
gh auth login
```
