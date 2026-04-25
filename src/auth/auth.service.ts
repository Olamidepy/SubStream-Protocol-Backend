import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  async validateSEP10Token(token: string): Promise<any> {
    try {
      // Decode and verify SEP-10 JWT token
      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET || 'default-secret',
      });

      // Extract Stellar public key from 'sub' claim
      const stellarPublicKey = payload.sub;
      
      if (!stellarPublicKey) {
        throw new Error('Invalid SEP-10 token: missing sub claim');
      }

      // Verify token expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        throw new Error('Token has expired');
      }

      return {
        stellarPublicKey,
        payload,
      };
    } catch (error) {
      throw new Error(`Token validation failed: ${error.message}`);
    }
  }

  async extractPublicKeyFromToken(token: string): Promise<string> {
    const { stellarPublicKey } = await this.validateSEP10Token(token);
    return stellarPublicKey;
  }

  isTokenExpired(token: string): boolean {
    try {
      const payload = this.jwtService.decode(token);
      if (!payload || !payload.exp) {
        return true;
      }
      
      const now = Math.floor(Date.now() / 1000);
      return payload.exp < now;
    } catch (error) {
      return true;
    }
  }
}
