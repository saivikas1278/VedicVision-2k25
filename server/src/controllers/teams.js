import { validationResult } from 'express-validator';
import Team from '../models/Team.js';
import Tournament from '../models/Tournament.js';
import User from '../models/User.js';
import Match from '../models/Match.js';

// @desc    Get all teams
// @route   GET /api/teams
// @access  Public
export const getTeams = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const startIndex = (page - 1) * limit;

    let query = {};

    // Filters
    if (req.query.tournament) {
      query.tournament = req.query.tournament;
    }

    if (req.query.sport) {
      query.sport = req.query.sport;
    }

    if (req.query.captain) {
      query.captain = req.query.captain;
    }

    if (req.query.city) {
      query['homeVenue.city'] = { $regex: req.query.city, $options: 'i' };
    }

    const teams = await Team.find(query)
      .populate('captain', 'firstName lastName avatar')
      .populate('players.user', 'firstName lastName avatar')
      .populate('tournament', 'name sport')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip(startIndex);

    const total = await Team.countDocuments(query);

    // Pagination result
    const pagination = {};

    if (startIndex + limit < total) {
      pagination.next = {
        page: page + 1,
        limit
      };
    }

    if (startIndex > 0) {
      pagination.prev = {
        page: page - 1,
        limit
      };
    }

    res.status(200).json({
      success: true,
      count: teams.length,
      total,
      pagination,
      data: teams
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single team
// @route   GET /api/teams/:id
// @access  Public
export const getTeam = async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.id)
      .populate('captain', 'firstName lastName avatar email')
      .populate('players.user', 'firstName lastName avatar sports')
      .populate('tournament', 'name sport organizer dates status');

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found'
      });
    }

    res.status(200).json({
      success: true,
      data: team
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new team
// @route   POST /api/teams
// @access  Private
export const createTeam = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array()
      });
    }

    // Verify tournament exists
    const tournament = await Tournament.findById(req.body.tournament);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        error: 'Tournament not found'
      });
    }

    // Check if registration is open
    if (tournament.registrationStatus !== 'open') {
      return res.status(400).json({
        success: false,
        error: 'Tournament registration is not open'
      });
    }

    // Check if tournament is full
    if (tournament.registeredTeams.length >= tournament.maxTeams) {
      return res.status(400).json({
        success: false,
        error: 'Tournament is full'
      });
    }

    // Check if user already has a team in this tournament
    const existingTeam = await Team.findOne({
      tournament: req.body.tournament,
      captain: req.user.id
    });

    if (existingTeam) {
      return res.status(400).json({
        success: false,
        error: 'You already have a team in this tournament'
      });
    }

    // Add captain and current user to team data
    req.body.captain = req.user.id;
    req.body.players = [{
      user: req.user.id,
      role: 'captain',
      joinedAt: new Date()
    }];

    const team = await Team.create(req.body);

    // Add team to tournament
    tournament.registeredTeams.push(team._id);
    await tournament.save();

    // Populate team data before sending response
    await team.populate('captain', 'firstName lastName avatar');
    await team.populate('players.user', 'firstName lastName avatar');
    await team.populate('tournament', 'name sport');

    res.status(201).json({
      success: true,
      data: team
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update team
// @route   PUT /api/teams/:id
// @access  Private
export const updateTeam = async (req, res, next) => {
  try {
    let team = await Team.findById(req.params.id);

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found'
      });
    }

    // Make sure user is team captain
    if (team.captain.toString() !== req.user.id) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized to update this team'
      });
    }

    // Don't allow certain updates after tournament starts
    const tournament = await Tournament.findById(team.tournament);
    if (tournament.status !== 'open' && tournament.status !== 'draft') {
      const restrictedFields = ['name', 'sport'];
      const hasRestrictedField = restrictedFields.some(field => req.body[field]);
      
      if (hasRestrictedField) {
        return res.status(400).json({
          success: false,
          error: 'Cannot modify team details after tournament starts'
        });
      }
    }

    const fieldsToUpdate = {};
    const allowedFields = [
      'name', 'shortName', 'logo', 'homeVenue', 'description', 
      'founded', 'colors', 'social'
    ];

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        fieldsToUpdate[field] = req.body[field];
      }
    });

    team = await Team.findByIdAndUpdate(req.params.id, fieldsToUpdate, {
      new: true,
      runValidators: true
    })
      .populate('captain', 'firstName lastName avatar')
      .populate('players.user', 'firstName lastName avatar')
      .populate('tournament', 'name sport');

    res.status(200).json({
      success: true,
      data: team
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete team
// @route   DELETE /api/teams/:id
// @access  Private
export const deleteTeam = async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.id);

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found'
      });
    }

    // Make sure user is team captain
    if (team.captain.toString() !== req.user.id) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized to delete this team'
      });
    }

    // Check if team has played any matches
    const matchCount = await Match.countDocuments({
      $or: [
        { homeTeam: team._id },
        { awayTeam: team._id }
      ],
      status: { $in: ['completed', 'live'] }
    });

    if (matchCount > 0) {
      return res.status(400).json({
        success: false,
        error: 'Cannot delete team that has played matches'
      });
    }

    // Remove team from tournament
    const tournament = await Tournament.findById(team.tournament);
    if (tournament) {
      tournament.registeredTeams = tournament.registeredTeams.filter(
        teamId => teamId.toString() !== team._id.toString()
      );
      await tournament.save();
    }

    await team.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Team deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Add player to team
// @route   POST /api/teams/:id/players
// @access  Private
export const addPlayerToTeam = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array()
      });
    }

    const team = await Team.findById(req.params.id);

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found'
      });
    }

    // Make sure user is team captain
    if (team.captain.toString() !== req.user.id) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized to add players to this team'
      });
    }

    // Verify user exists
    const user = await User.findById(req.body.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Check if user is already in team
    const existingPlayer = team.players.find(
      player => player.user.toString() === req.body.userId
    );

    if (existingPlayer) {
      return res.status(400).json({
        success: false,
        error: 'User is already in this team'
      });
    }

    // Check team size limits
    const tournament = await Tournament.findById(team.tournament);
    if (team.players.length >= tournament.settings.maxPlayersPerTeam) {
      return res.status(400).json({
        success: false,
        error: 'Team is full'
      });
    }

    // Check if jersey number is already taken
    if (req.body.jerseyNumber) {
      const existingJersey = team.players.find(
        player => player.jerseyNumber === req.body.jerseyNumber
      );

      if (existingJersey) {
        return res.status(400).json({
          success: false,
          error: 'Jersey number is already taken'
        });
      }
    }

    // Add player to team
    await team.addPlayer(
      req.body.userId,
      req.body.role || 'player',
      req.body.jerseyNumber,
      req.body.position
    );

    // Populate team data
    await team.populate('players.user', 'firstName lastName avatar');

    res.status(200).json({
      success: true,
      data: team
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Remove player from team
// @route   DELETE /api/teams/:id/players/:userId
// @access  Private
export const removePlayerFromTeam = async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.id);

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found'
      });
    }

    // Make sure user is team captain
    if (team.captain.toString() !== req.user.id) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized to remove players from this team'
      });
    }

    // Can't remove captain
    if (req.params.userId === team.captain.toString()) {
      return res.status(400).json({
        success: false,
        error: 'Cannot remove team captain'
      });
    }

    // Check if player exists in team
    const player = team.players.find(
      player => player.user.toString() === req.params.userId
    );

    if (!player) {
      return res.status(404).json({
        success: false,
        error: 'Player not found in team'
      });
    }

    // Remove player from team
    await team.removePlayer(req.params.userId);

    res.status(200).json({
      success: true,
      message: 'Player removed from team successfully'
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get team statistics
// @route   GET /api/teams/:id/stats
// @access  Public
export const getTeamStats = async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.id);

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found'
      });
    }

    // Calculate additional stats
    const winRate = team.stats.matchesPlayed > 0 ? 
      ((team.stats.matchesWon / team.stats.matchesPlayed) * 100).toFixed(2) : 0;

    const stats = {
      ...team.stats.toObject(),
      winRate,
      goalDifference: team.goalDifference,
      teamSize: team.teamSize
    };

    res.status(200).json({
      success: true,
      data: stats
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get team matches
// @route   GET /api/teams/:id/matches
// @access  Public
export const getTeamMatches = async (req, res, next) => {
  try {
    const team = await Team.findById(req.params.id);

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found'
      });
    }

    const matches = await Match.find({
      $or: [
        { homeTeam: team._id },
        { awayTeam: team._id }
      ]
    })
      .populate('tournament', 'name sport')
      .populate('homeTeam', 'name logo shortName')
      .populate('awayTeam', 'name logo shortName')
      .sort({ scheduledTime: -1 });

    res.status(200).json({
      success: true,
      count: matches.length,
      data: matches
    });
  } catch (error) {
    next(error);
  }
};
