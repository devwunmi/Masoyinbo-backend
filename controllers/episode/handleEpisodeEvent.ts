// controller/episode/handleEpisodeEvent.ts
import { Request, Response, NextFunction } from 'express';
import { EpisodeModel } from "../../models/episode";
import { EpisodeEventsModel } from "../../models/episodeEvents";
import { Participants } from '../../models/participants';

import mongoose from 'mongoose';

export async function getEpisodeEventDetail(req: Request, res: Response, next: NextFunction) {
  try {
    const { episodeId } = req.query as { episodeId?: string };

    if (!episodeId) {
      return res.status(400).json({ message: 'episodeId is required' });
    }

    const episodeObjectId = new mongoose.Types.ObjectId(episodeId);

    // Retrieve episode details including episodeLink, episodeDate, and availableAmounToWin
    const episodeDetails = await EpisodeModel.findById(episodeObjectId).exec();

    if (!episodeDetails) {
      return res.status(404).json({ message: 'Episode not found' });
    }

    // Aggregate events
    const events = await EpisodeEventsModel.aggregate([
      {
        $match: {
          episodeId: episodeObjectId
        }
      },
      {
        $lookup: {
          from: 'episodes',
          localField: 'episodeId',
          foreignField: '_id',
          as: 'episode'
        }
      },
      {
        $unwind: '$episode'
      },
      {
        $lookup: {
          from: 'participants',
          localField: 'episode.participant_id',
          foreignField: '_id',
          as: 'participant'
        }
      },
      {
        $unwind: '$participant'
      },
      {
        $match: {
          'participant.status': 'Completed'
        }
      },
      {
        $project: {
          question: 1,
          correctAnswer: 1,
          response: 1,
          isCorrect: 1,
          type: 1,
          amount: 1,
          balance: 1,
          participantFullName: '$participant.fullName',
          episodeDate: '$episode.date'
        }
      }
    ]);

    if (events.length === 0) {
      return res.status(404).json({ message: 'No events found with participants' });
    }

    const participantName = events[0]?.participantFullName;
    const totalEvents = events.length;

    const message = `Successfully retrieved ${totalEvents} event(s) for participant ${participantName}.`;

    return res.status(200).json({
      message,
      events,
      episodeLink: episodeDetails.episodeLink,
      episodeDate: episodeDetails.date,
      totalAmountAvailableToWin: episodeDetails.availableAmounToWin
    });

  } catch (error: any) {
    console.error('Error retrieving episode details:', error);
    return res.status(500).json({ message: 'Error retrieving episode details', error: error.message });
  }
}

export async function handleEpisodeEvent(req: Request, res: Response, next: NextFunction) {
  try {
    const { episodeId, events } = req.body;

    const episode = await EpisodeModel.findById(episodeId).exec();
    if (!episode) {
      return res.status(404).json({ message: 'Episode not found' });
    }

    const savedEvents = [];
    for (const event of events) {
      const { question, correctAnswer, response = "No response?", type, amount, balance } = event;

      const normalizedResponse = response.trim() === "" ? "No response?" : response;

      const isCorrect = (type === 'QUESTION_NUMBER' || type === 'QUESTION') &&
        normalizedResponse !== "No response?" &&
        correctAnswer &&
        normalizedResponse.trim().toLowerCase() === correctAnswer.trim().toLowerCase();

      const episodeEvent = new EpisodeEventsModel({
        question,
        correctAnswer,
        response: normalizedResponse,
        ...(type === 'QUESTION_NUMBER' || type === 'QUESTION' ? { isCorrect } : {}),
        type,
        amount,
        balance,
        episodeId,
      });

      await episodeEvent.save();
      savedEvents.push(episodeEvent);
    }

    return res.status(200).json({ message: 'Episode events handled successfully', events: savedEvents });
  } catch (error: any) {
    console.error('Error handling episode events:', error);
    return res.status(500).json({ message: 'Error handling episode events', error: error.message });
  }
}

export async function getEpisodeStats(req: Request, res: Response, next: NextFunction) {
  try {
    const episodes = await EpisodeModel.find({})
      .sort({ date: -1 })
      .select('episodeLink');

    const totalEpisodes = episodes.length;

    // Aggregate total questions asked, correct answers, and total amount won
    const [totalAskedQuestionsData, totalRightQuestionsData, totalAmountWonData] = await Promise.all([
      EpisodeEventsModel.aggregate([
        {
          $match: {
            type: { $in: ['QUESTION', 'QUESTION_NUMBER'] }
          }
        },
        {
          $group: {
            _id: null, totalQuestions: { $sum: 1 }, questions: { $push: "$question" }
          }
        }
      ]),
      EpisodeEventsModel.aggregate([
        { $match: { isCorrect: true } },
        { $group: { _id: null, totalCorrectAnswers: { $sum: 1 }, correctAnswers: { $push: "$correctAnswer" } } }
      ]),
      EpisodeModel.aggregate([
        { $group: { _id: null, totalAmountWon: { $sum: "$amountWon" } } }
      ])
    ]);

    const totalAskedQuestions = totalAskedQuestionsData[0]?.totalQuestions || 0;
    const totalRightQuestions = totalRightQuestionsData[0]?.totalCorrectAnswers || 0;
    const totalAmountWon = totalAmountWonData[0]?.totalAmountWon || 0;

    // Fetch participants with 'Pending' status for the request pool
    const pendingParticipants = await Participants.find({ status: 'Pending' }).select('fullName email state gender status socialMediaHandle');

    return res.status(200).json({
      stats: {
        message: 'Successfully retrieved stats',
        totalEpisodes,
        totalAskedQuestions,
        totalRightQuestions: {
          count: totalRightQuestions,
          correctAnswers: totalRightQuestionsData[0]?.correctAnswers || []
        },
        totalAmountWon,
        requestPool: {
          total: pendingParticipants.length,
          participants: pendingParticipants
        },
        episodeLinks: episodes.map(episode => ({
          episodeLink: episode.episodeLink,
          id: episode._id
        })),
      },
    });
  } catch (error: any) {
    console.error('Error retrieving episode statistics:', error);
    return res.status(500).json({ message: 'Error retrieving episode statistics', error: error.message });
  }
}

export async function getGlobalPerformanceStats(req: Request, res: Response, next: NextFunction) {
  try {
    const totalAmountWon = await EpisodeEventsModel.aggregate([
      {
        $match: {
          type: { $in: ['QUESTION', 'QUESTION_NUMBER'] }, isCorrect: true
        }
      },
      {
        $group: {
          _id: "$type", totalAmountWon: { $sum: "$amount" }, totalCorrectQuestions: { $sum: 1 }
        }
      }
    ]);

    const totalAmountLost = await EpisodeEventsModel.aggregate([
      {
        $match: {
          type: { $in: ['QUESTION', 'QUESTION_NUMBER'] }, isCorrect: false
        }
      },
      {
        $group: {
          _id: "$type", totalAmountLost: { $sum: "$amount" }, totalIncorrectQuestions: { $sum: 1 }
        }
      }
    ]);

    const totalQuestions = await EpisodeEventsModel.aggregate([
      {
        $match: {
          type: { $in: ['QUESTION', 'QUESTION_NUMBER'] }
        }
      },
      {
        $group: {
          _id: null, totalAskedQuestions: { $sum: 1 }
        }
      }
    ]);

    const codemixWordLoss = await EpisodeEventsModel.aggregate([
      {
        $match: { type: "CODE_MIX" }
      },
      {
        $group: { _id: "$response", totalAmountLost: { $sum: "$amount" } }
      },
      {
        $sort: { totalAmountLost: -1 }
      }
    ]);

    const totalCodemixResponses = await EpisodeEventsModel.aggregate([
      {
        $match: { type: "CODE_MIX" }
      },
      {
        $group: { _id: "$response", totalResponses: { $sum: 1 } }
      }
    ]);

    const response = {
      totalAmountWon: {
        QUESTION: totalAmountWon.find(t => t._id === 'QUESTION') || { totalAmountWon: 0, totalCorrectQuestions: 0 },
        QUESTION_NUMBER: totalAmountWon.find(t => t._id === 'QUESTION_NUMBER') || { totalAmountWon: 0, totalCorrectQuestions: 0 },
      },
      totalAmountLost: {
        QUESTION: totalAmountLost.find(t => t._id === 'QUESTION') || { totalAmountLost: 0, totalIncorrectQuestions: 0 },
        QUESTION_NUMBER: totalAmountLost.find(t => t._id === 'QUESTION_NUMBER') || { totalAmountLost: 0, totalIncorrectQuestions: 0 },
      },
      totalAskedQuestions: totalQuestions.length ? totalQuestions[0].totalAskedQuestions : 0,
      codemixWordLoss,
      totalCodemixResponses

    };

    return res.status(200).json(response);

  } catch (error: any) {
    console.error('Error retrieving performance stats:', error);
    return res.status(500).json({ message: 'Error retrieving performance stats', error: error.message });
  }
}