import { IsISO8601, IsLatitude, IsLongitude, IsNumber, Min } from 'class-validator';

export class LocationDto {
  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;

  @IsNumber()
  @Min(0)
  accuracyMeters!: number;

  @IsISO8601()
  locationTimestamp!: string;
}
