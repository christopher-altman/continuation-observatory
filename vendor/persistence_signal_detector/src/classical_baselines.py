"""
Classical baselines for comparison with the Quantum Boltzmann Machine.

Provides:
    - ClassicalRBM: standard Restricted Boltzmann Machine (no quantum term).
    - Autoencoder: simple feed-forward autoencoder with bottleneck.

Both models expose an `encode` method returning latent representations
so that downstream UCIP analysis can be run identically.
"""

from __future__ import annotations

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Classical Restricted Boltzmann Machine
# ---------------------------------------------------------------------------

class ClassicalRBM:
    """Standard RBM trained with contrastive divergence.

    Parameters
    ----------
    n_visible : int
    n_hidden : int
    learning_rate : float
    cd_steps : int
    n_epochs : int
    batch_size : int
    seed : int
    """

    def __init__(
        self,
        n_visible: int = 7,
        n_hidden: int = 16,
        learning_rate: float = 0.01,
        cd_steps: int = 1,
        n_epochs: int = 50,
        batch_size: int = 32,
        seed: int = 42,
    ):
        self.n_visible = n_visible
        self.n_hidden = n_hidden
        self.lr = learning_rate
        self.cd_steps = cd_steps
        self.n_epochs = n_epochs
        self.batch_size = batch_size
        self.rng = np.random.default_rng(seed)

        self.W = self.rng.normal(0, 0.01, (n_visible, n_hidden))
        self.b = np.zeros(n_visible)
        self.c = np.zeros(n_hidden)

        self.loss_history: list[float] = []

    def _sigmoid(self, x: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-np.clip(x, -500, 500)))

    def hidden_probs(self, v: np.ndarray) -> np.ndarray:
        return self._sigmoid(v @ self.W + self.c)

    def visible_probs(self, h: np.ndarray) -> np.ndarray:
        return self._sigmoid(h @ self.W.T + self.b)

    def sample_hidden(self, v: np.ndarray) -> np.ndarray:
        p = self.hidden_probs(v)
        return (self.rng.random(p.shape) < p).astype(np.float64)

    def sample_visible(self, h: np.ndarray) -> np.ndarray:
        p = self.visible_probs(h)
        return (self.rng.random(p.shape) < p).astype(np.float64)

    def fit(self, data: np.ndarray, verbose: bool = False) -> "ClassicalRBM":
        data = (data > 0.5).astype(np.float64) if data.max() > 1 else data
        N = data.shape[0]

        for epoch in range(self.n_epochs):
            perm = self.rng.permutation(N)
            epoch_loss = 0.0
            for start in range(0, N, self.batch_size):
                batch = data[perm[start:start + self.batch_size]]
                bs = batch.shape[0]

                h0 = self.hidden_probs(batch)
                pos_W = (batch.T @ h0) / bs
                pos_b = batch.mean(axis=0)
                pos_c = h0.mean(axis=0)

                v = batch.copy()
                for _ in range(self.cd_steps):
                    h = self.sample_hidden(v)
                    v = self.sample_visible(h)
                h_neg = self.hidden_probs(v)

                neg_W = (v.T @ h_neg) / bs
                neg_b = v.mean(axis=0)
                neg_c = h_neg.mean(axis=0)

                self.W += self.lr * (pos_W - neg_W)
                self.b += self.lr * (pos_b - neg_b)
                self.c += self.lr * (pos_c - neg_c)

                recon = self.visible_probs(h0)
                epoch_loss += np.mean((batch - recon) ** 2) * bs

            epoch_loss /= N
            self.loss_history.append(epoch_loss)
            if verbose and (epoch % 10 == 0 or epoch == self.n_epochs - 1):
                print(f"  Epoch {epoch:4d}  |  recon loss = {epoch_loss:.6f}")
        return self

    def encode(self, v: np.ndarray) -> np.ndarray:
        return self.hidden_probs(v)

    def reconstruct(self, v: np.ndarray) -> np.ndarray:
        return self.visible_probs(self.hidden_probs(v))


# ---------------------------------------------------------------------------
# Feed-forward Autoencoder
# ---------------------------------------------------------------------------

class Autoencoder:
    """Minimal numpy-only autoencoder with one hidden (bottleneck) layer.

    Architecture: input → encoder → bottleneck → decoder → output
    All activations are sigmoid; trained with MSE loss via gradient descent.

    Parameters
    ----------
    n_input : int
    n_bottleneck : int
    n_encoder : int
        Width of the encoder/decoder hidden layer.
    learning_rate : float
    n_epochs : int
    batch_size : int
    seed : int
    """

    def __init__(
        self,
        n_input: int = 7,
        n_bottleneck: int = 16,
        n_encoder: int = 32,
        learning_rate: float = 0.005,
        n_epochs: int = 100,
        batch_size: int = 32,
        seed: int = 42,
    ):
        self.n_input = n_input
        self.n_bottleneck = n_bottleneck
        self.n_encoder = n_encoder
        self.lr = learning_rate
        self.n_epochs = n_epochs
        self.batch_size = batch_size
        self.rng = np.random.default_rng(seed)

        # Xavier initialisation
        def _init(fan_in, fan_out):
            s = np.sqrt(2.0 / (fan_in + fan_out))
            return self.rng.normal(0, s, (fan_in, fan_out))

        self.W1 = _init(n_input, n_encoder)
        self.b1 = np.zeros(n_encoder)
        self.W2 = _init(n_encoder, n_bottleneck)
        self.b2 = np.zeros(n_bottleneck)
        self.W3 = _init(n_bottleneck, n_encoder)
        self.b3 = np.zeros(n_encoder)
        self.W4 = _init(n_encoder, n_input)
        self.b4 = np.zeros(n_input)

        self.loss_history: list[float] = []

    @staticmethod
    def _sigmoid(x: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-np.clip(x, -500, 500)))

    def _forward(self, x: np.ndarray):
        z1 = self._sigmoid(x @ self.W1 + self.b1)
        z2 = self._sigmoid(z1 @ self.W2 + self.b2)       # bottleneck
        z3 = self._sigmoid(z2 @ self.W3 + self.b3)
        out = self._sigmoid(z3 @ self.W4 + self.b4)
        return z1, z2, z3, out

    def fit(self, data: np.ndarray, verbose: bool = False) -> "Autoencoder":
        data = np.asarray(data, dtype=np.float64)
        # Normalise to [0, 1]
        dmin, dmax = data.min(), data.max()
        if dmax - dmin > 1e-8:
            data = (data - dmin) / (dmax - dmin)
        N = data.shape[0]

        for epoch in range(self.n_epochs):
            perm = self.rng.permutation(N)
            epoch_loss = 0.0
            for start in range(0, N, self.batch_size):
                x = data[perm[start:start + self.batch_size]]
                bs = x.shape[0]

                # Forward
                z1, z2, z3, out = self._forward(x)

                # Backward (MSE loss, sigmoid derivative = s*(1-s))
                d_out = (out - x) * out * (1 - out) * (2.0 / bs)

                d_W4 = z3.T @ d_out
                d_b4 = d_out.sum(axis=0)

                d_z3 = (d_out @ self.W4.T) * z3 * (1 - z3)
                d_W3 = z2.T @ d_z3
                d_b3 = d_z3.sum(axis=0)

                d_z2 = (d_z3 @ self.W3.T) * z2 * (1 - z2)
                d_W2 = z1.T @ d_z2
                d_b2 = d_z2.sum(axis=0)

                d_z1 = (d_z2 @ self.W2.T) * z1 * (1 - z1)
                d_W1 = x.T @ d_z1
                d_b1 = d_z1.sum(axis=0)

                # Update
                self.W4 -= self.lr * d_W4
                self.b4 -= self.lr * d_b4
                self.W3 -= self.lr * d_W3
                self.b3 -= self.lr * d_b3
                self.W2 -= self.lr * d_W2
                self.b2 -= self.lr * d_b2
                self.W1 -= self.lr * d_W1
                self.b1 -= self.lr * d_b1

                epoch_loss += np.mean((x - out) ** 2) * bs

            epoch_loss /= N
            self.loss_history.append(epoch_loss)
            if verbose and (epoch % 20 == 0 or epoch == self.n_epochs - 1):
                print(f"  Epoch {epoch:4d}  |  MSE = {epoch_loss:.6f}")

        return self

    def encode(self, x: np.ndarray) -> np.ndarray:
        """Return bottleneck activations."""
        x = np.asarray(x, dtype=np.float64)
        z1 = self._sigmoid(x @ self.W1 + self.b1)
        z2 = self._sigmoid(z1 @ self.W2 + self.b2)
        return z2

    def reconstruct(self, x: np.ndarray) -> np.ndarray:
        _, _, _, out = self._forward(x)
        return out


# ---------------------------------------------------------------------------
# Variational Autoencoder (VAE)
# ---------------------------------------------------------------------------

class VariationalAutoencoder:
    """Minimal numpy-only Variational Autoencoder.

    Architecture:
        input → encoder_hidden → (mu, log_var) → reparameterize → z → decoder → output

    Loss: MSE reconstruction + beta * KL divergence (beta-VAE formulation).

    The ``encode`` method returns the posterior mean ``mu`` (deterministic, not a
    sample) so that downstream UCIP analysis can be run identically to the RBM
    and Autoencoder baselines.

    Parameters
    ----------
    n_input : int
    n_latent : int
        Latent dimension (analogous to n_hidden in QBM/RBM).
    n_encoder : int
        Width of encoder and decoder hidden layers.
    learning_rate : float
    n_epochs : int
    batch_size : int
    kl_weight : float
        Beta coefficient for KL term (1.0 = standard VAE).
    seed : int
    """

    def __init__(
        self,
        n_input: int = 7,
        n_latent: int = 8,
        n_encoder: int = 32,
        learning_rate: float = 0.005,
        n_epochs: int = 100,
        batch_size: int = 32,
        kl_weight: float = 1.0,
        seed: int = 42,
    ):
        self.n_input = n_input
        self.n_latent = n_latent
        self.n_encoder = n_encoder
        self.lr = learning_rate
        self.n_epochs = n_epochs
        self.batch_size = batch_size
        self.kl_weight = kl_weight
        self.rng = np.random.default_rng(seed)

        def _init(fan_in: int, fan_out: int) -> np.ndarray:
            scale = np.sqrt(2.0 / (fan_in + fan_out))
            return self.rng.normal(0, scale, (fan_in, fan_out))

        # Encoder: input → encoder hidden
        self.W_enc = _init(n_input, n_encoder)
        self.b_enc = np.zeros(n_encoder)

        # Two heads: mean and log-variance of q(z|x)
        self.W_mu = _init(n_encoder, n_latent)
        self.b_mu = np.zeros(n_latent)
        self.W_logvar = _init(n_encoder, n_latent)
        self.b_logvar = np.zeros(n_latent)

        # Decoder: z → decoder hidden → output
        self.W_dec1 = _init(n_latent, n_encoder)
        self.b_dec1 = np.zeros(n_encoder)
        self.W_dec2 = _init(n_encoder, n_input)
        self.b_dec2 = np.zeros(n_input)

        self.loss_history: list[float] = []
        self._data_min: float = 0.0
        self._data_max: float = 1.0

    @staticmethod
    def _sigmoid(x: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-np.clip(x, -500, 500)))

    def _encoder_hidden(self, x: np.ndarray) -> np.ndarray:
        return self._sigmoid(x @ self.W_enc + self.b_enc)

    def _encode_params(self, x: np.ndarray):
        """Return (h_enc, mu, log_var) for a batch."""
        h = self._encoder_hidden(x)
        mu = h @ self.W_mu + self.b_mu
        log_var = np.clip(h @ self.W_logvar + self.b_logvar, -10.0, 10.0)
        return h, mu, log_var

    def _reparameterize(self, mu: np.ndarray, log_var: np.ndarray) -> np.ndarray:
        std = np.exp(0.5 * log_var)
        eps = self.rng.standard_normal(mu.shape)
        return mu + eps * std

    def _decode(self, z: np.ndarray) -> np.ndarray:
        h = self._sigmoid(z @ self.W_dec1 + self.b_dec1)
        return self._sigmoid(h @ self.W_dec2 + self.b_dec2)

    def fit(self, data: np.ndarray, verbose: bool = False) -> "VariationalAutoencoder":
        data = np.asarray(data, dtype=np.float64)
        dmin, dmax = data.min(), data.max()
        if dmax - dmin > 1e-8:
            data = (data - dmin) / (dmax - dmin)
        self._data_min = dmin
        self._data_max = dmax

        N = data.shape[0]

        for epoch in range(self.n_epochs):
            perm = self.rng.permutation(N)
            epoch_loss = 0.0

            for start in range(0, N, self.batch_size):
                x = data[perm[start : start + self.batch_size]]
                bs = x.shape[0]

                # ---- Forward pass ----
                h_enc = self._encoder_hidden(x)
                mu = h_enc @ self.W_mu + self.b_mu
                log_var = np.clip(h_enc @ self.W_logvar + self.b_logvar, -10.0, 10.0)
                std = np.exp(0.5 * log_var)
                eps = self.rng.standard_normal(mu.shape)
                z = mu + eps * std

                h_dec = self._sigmoid(z @ self.W_dec1 + self.b_dec1)
                x_hat = self._sigmoid(h_dec @ self.W_dec2 + self.b_dec2)

                # ---- Losses ----
                recon_loss = np.mean((x - x_hat) ** 2)
                kl_loss = -0.5 * np.mean(
                    np.sum(1.0 + log_var - mu ** 2 - np.exp(log_var), axis=1)
                )
                epoch_loss += (recon_loss + self.kl_weight * kl_loss) * bs

                # ---- Backward pass ----
                # Decoder gradients (MSE, sigmoid output)
                d_xhat = 2.0 * (x_hat - x) * x_hat * (1.0 - x_hat) / bs
                d_W_dec2 = h_dec.T @ d_xhat
                d_b_dec2 = d_xhat.sum(axis=0)
                d_h_dec = (d_xhat @ self.W_dec2.T) * h_dec * (1.0 - h_dec)
                d_W_dec1 = z.T @ d_h_dec
                d_b_dec1 = d_h_dec.sum(axis=0)

                # Gradient flowing into z
                d_z = d_h_dec @ self.W_dec1.T

                # KL gradients wrt mu and log_var
                d_mu_kl = (self.kl_weight / bs) * mu
                d_logvar_kl = (self.kl_weight / bs) * 0.5 * (np.exp(log_var) - 1.0)

                # Reparameterization: dL/d_mu and dL/d_logvar
                d_mu = d_z + d_mu_kl
                d_logvar = d_z * eps * std * 0.5 + d_logvar_kl

                # Encoder gradients
                d_W_mu = h_enc.T @ d_mu
                d_b_mu = d_mu.sum(axis=0)
                d_W_logvar = h_enc.T @ d_logvar
                d_b_logvar = d_logvar.sum(axis=0)
                d_h_enc = (
                    (d_mu @ self.W_mu.T + d_logvar @ self.W_logvar.T)
                    * h_enc * (1.0 - h_enc)
                )
                d_W_enc = x.T @ d_h_enc
                d_b_enc = d_h_enc.sum(axis=0)

                # Parameter updates
                for param, grad in [
                    (self.W_dec2, d_W_dec2),
                    (self.b_dec2, d_b_dec2),
                    (self.W_dec1, d_W_dec1),
                    (self.b_dec1, d_b_dec1),
                    (self.W_mu, d_W_mu),
                    (self.b_mu, d_b_mu),
                    (self.W_logvar, d_W_logvar),
                    (self.b_logvar, d_b_logvar),
                    (self.W_enc, d_W_enc),
                    (self.b_enc, d_b_enc),
                ]:
                    param -= self.lr * grad

            epoch_loss /= N
            self.loss_history.append(epoch_loss)
            if verbose and (epoch % 20 == 0 or epoch == self.n_epochs - 1):
                print(f"  Epoch {epoch:4d}  |  VAE loss = {epoch_loss:.6f}")

        return self

    def encode(self, x: np.ndarray) -> np.ndarray:
        """Return the posterior mean mu (deterministic latent representation).

        Returns the same shape as ``ClassicalRBM.encode`` and ``Autoencoder.encode``
        for identical downstream UCIP analysis.
        """
        x = np.asarray(x, dtype=np.float64)
        _, mu, _ = self._encode_params(x)
        return mu

    def reconstruct(self, x: np.ndarray) -> np.ndarray:
        """Reconstruct input via a single posterior sample."""
        x = np.asarray(x, dtype=np.float64)
        _, mu, log_var = self._encode_params(x)
        z = self._reparameterize(mu, log_var)
        return self._decode(z)
